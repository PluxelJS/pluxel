import { providerStepSnapshot, readRecord, boundedText, assertExactKeys } from './authentication'
import type { Context as PluxelContext, PluginContext } from '@pluxel/core'
import { enterOwnerInvocation, requirePluginService } from '@pluxel/core/internal'

import { pinOwnerContext, recordSecurityEvent } from '../../../internal'
import { responseWithLease, type ResponseLease } from './response-lifetime'
import {
	ADMIN_ACCESS_COOKIE_COMMIT_PATH,
	ADMIN_ACCESS_OIDC_CALLBACK_PATH,
	ADMIN_ACCESS_OIDC_START_PATH,
} from './transport'
import type {
	AdminAccessOverview,
	AdminAccessPrincipal,
	AdminAccessReason,
	AdminAccessState,
	ManagementAccessProvider,
	ManagementAccessProviderStatus,
	ManagementAccessRegistration,
	ManagementAuthenticationCookieCommit,
	ManagementAuthenticationFailureCode,
	ManagementAuthenticationProviderSession,
	ManagementAuthenticationProviderStep,
} from './types'

type ProviderRegistration = Readonly<{
	owner: PluginContext
	provider: ManagementAccessProvider
	authority: AbortSignal
	credentials: WeakMap<AbortSignal, AbortSignal>
}>

type ActiveProvider = Readonly<{
	registration: ProviderRegistration
	status: ManagementAccessProviderStatus
	lease: ResponseLease
}>

export type AdminAccessAdmission = Readonly<{
	state: AdminAccessState
	signal: AbortSignal
	release(): void
}>

export interface AdminAuthenticationSession {
	readonly signal: AbortSignal
	/** Authority lifetime only; physical connection closure does not revoke admitted script runs. */
	readonly authorizationSignal: AbortSignal
	readonly providerId: string
	state(): Promise<ManagementAuthenticationProviderStep>
	submit(input: unknown): Promise<ManagementAuthenticationProviderStep>
	logout(): Promise<ManagementAuthenticationCookieCommit | undefined>
	release(): void
}

const MAX_AUTH_ATTEMPTS = 8
const MAX_AUTH_INPUT_BYTES = 16 * 1024
const AUTHENTICATION_DEADLINE_MS = 2 * 60_000
const NOOP_RELEASE = (): void => undefined

function authoritySignal(owner: PluxelContext): AbortSignal {
	const lease = enterOwnerInvocation(owner)
	try {
		return lease.signal
	} finally {
		lease.dispose()
	}
}

function providerRequest(request: Request, signal: AbortSignal, includeBody = false): Request {
	const hasBody = includeBody && request.method !== 'GET' && request.method !== 'HEAD'
	const headers = new Headers(request.headers)
	if (!hasBody) {
		headers.delete('content-length')
		headers.delete('transfer-encoding')
	}
	return new Request(request.url, {
		method: request.method,
		headers,
		signal,
		body: hasBody ? request.body : undefined,
		...(hasBody && request.body ? { duplex: 'half' } : {}),
	} as RequestInit)
}

function statusSnapshot(value: unknown): ManagementAccessProviderStatus {
	const input = readRecord(value, 'provider status') as Partial<ManagementAccessProviderStatus>
	assertExactKeys(input, ['id', 'label', 'method', 'ready'], 'provider status')
	const id = boundedText(input.id, 128)
	const label = boundedText(input.label, 128)
	if (!id || !/^[a-zA-Z0-9@._:/-]+$/.test(id)) {
		throw new TypeError('provider status.id is invalid')
	}
	if (!label) throw new TypeError('provider status.label is invalid')
	if (input.method !== 'oidc' && input.method !== 'password' && input.method !== 'password-totp') {
		throw new TypeError('provider status.method is invalid')
	}
	if (typeof input.ready !== 'boolean') throw new TypeError('provider status.ready is invalid')
	return Object.freeze({ id, label, method: input.method, ready: input.ready })
}

function failedStep(
	code: ManagementAuthenticationFailureCode,
): ManagementAuthenticationProviderStep {
	return Object.freeze({ kind: 'failed', code })
}

function authenticatedLocal(): ManagementAuthenticationProviderStep {
	return Object.freeze({
		kind: 'authenticated',
		principal: Object.freeze({ subject: 'local', displayName: 'Local recovery' }),
	})
}

class FixedAuthenticationSession implements AdminAuthenticationSession {
	constructor(
		readonly signal: AbortSignal,
		readonly authorizationSignal: AbortSignal,
		readonly providerId: string,
		private readonly step: ManagementAuthenticationProviderStep,
	) {}

	async state(): Promise<ManagementAuthenticationProviderStep> {
		return this.signal.aborted ? failedStep('authentication_expired') : this.step
	}

	async submit(_input: unknown): Promise<ManagementAuthenticationProviderStep> {
		return await this.state()
	}

	async logout(): Promise<undefined> {
		return undefined
	}

	release(): void {}
}

class ProviderAuthenticationSession implements AdminAuthenticationSession {
	private attempts = 0
	private active = true
	private submitting = false

	constructor(
		readonly signal: AbortSignal,
		readonly authorizationSignal: AbortSignal,
		readonly providerId: string,
		private readonly providerSession: ManagementAuthenticationProviderSession,
		private readonly lease: ResponseLease,
		private current: ManagementAuthenticationProviderStep,
		private readonly deadlineTimer: ReturnType<typeof setTimeout>,
	) {}

	async state(): Promise<ManagementAuthenticationProviderStep> {
		return this.expired() ? failedStep('authentication_expired') : this.current
	}

	async submit(input: unknown): Promise<ManagementAuthenticationProviderStep> {
		if (this.expired()) return failedStep('authentication_expired')
		if (this.current.kind !== 'challenge') return this.current
		if (
			this.submitting ||
			++this.attempts > MAX_AUTH_ATTEMPTS ||
			inputBytes(input) > MAX_AUTH_INPUT_BYTES
		) {
			this.current = failedStep('attempt_limited')
			return this.current
		}

		this.submitting = true
		try {
			this.current = providerStepSnapshot(await this.providerSession.submit(input))
			if (this.signal.aborted) this.current = failedStep('authentication_expired')
			return this.current
		} catch {
			this.current = failedStep('access_unavailable')
			return this.current
		} finally {
			this.submitting = false
		}
	}

	async logout(): Promise<ManagementAuthenticationCookieCommit | undefined> {
		if (this.expired() || typeof this.providerSession.logout !== 'function') return undefined
		try {
			const commit = await this.providerSession.logout()
			return commit === undefined ? undefined : cookieCommitSnapshot(commit)
		} catch {
			return undefined
		}
	}

	release(): void {
		if (!this.active) return
		this.active = false
		clearTimeout(this.deadlineTimer)
		try {
			this.providerSession[Symbol.dispose]()
		} finally {
			this.lease.dispose()
		}
	}

	private expired(): boolean {
		return !this.active || this.signal.aborted
	}
}

/** Runtime-owned, fail-closed gate for the Management Plane. */
export class AdminAccessService {
	private readonly registrations = new Set<ProviderRegistration>()

	constructor(public readonly ctx: PluxelContext) {
		pinOwnerContext(this, ctx)
	}

	async describe(): Promise<AdminAccessOverview> {
		let current: ActiveProvider | undefined
		try {
			current = this.currentProvider()
		} catch {
			return Object.freeze({ policy: 'provider-or-local-recovery', provider: null })
		}
		if (!current) return Object.freeze({ policy: 'provider-or-local-recovery', provider: null })
		current.lease.dispose()
		return Object.freeze({ policy: 'provider-or-local-recovery', provider: current.status })
	}

	/** Open one connection-bound pre-auth flow. Local physical peers get direct recovery authority. */
	async openSession(
		request: Request,
		local: boolean,
		secure: boolean,
	): Promise<AdminAuthenticationSession> {
		const rootAuthority = authoritySignal(this.ctx.root)
		if (local)
			return new FixedAuthenticationSession(
				request.signal,
				rootAuthority,
				'local',
				authenticatedLocal(),
			)
		if (!secure) {
			return new FixedAuthenticationSession(
				request.signal,
				rootAuthority,
				'unavailable',
				failedStep('access_unavailable'),
			)
		}

		const deadline = new AbortController()
		const deadlineTimer = setTimeout(
			() => deadline.abort(new Error('Management authentication deadline exceeded')),
			AUTHENTICATION_DEADLINE_MS,
		)
		deadlineTimer.unref?.()
		const callSignal = AbortSignal.any([request.signal, deadline.signal])
		let current: ActiveProvider | undefined
		try {
			current = this.currentProvider(callSignal)
		} catch {
			clearTimeout(deadlineTimer)
			return new FixedAuthenticationSession(
				request.signal,
				rootAuthority,
				'unavailable',
				failedStep('access_unavailable'),
			)
		}
		if (!current?.status.ready) {
			current?.lease.dispose()
			clearTimeout(deadlineTimer)
			return new FixedAuthenticationSession(
				request.signal,
				rootAuthority,
				'unavailable',
				failedStep('access_unavailable'),
			)
		}

		let providerSession: ManagementAuthenticationProviderSession | undefined
		try {
			providerSession = await current.registration.provider.open(
				providerRequest(request, current.lease.signal),
				Object.freeze({ local, secure }),
			)
			assertProviderSession(providerSession)
			const step = providerStepSnapshot(await providerSession.state())
			if (current.lease.signal.aborted) throw current.lease.signal.reason
			const registration = current.registration
			let authority = registration.authority
			const credential = providerSession.authorizationSignal
			if (credential) {
				const shared =
					registration.credentials.get(credential) ?? AbortSignal.any([authority, credential])
				registration.credentials.set(credential, shared)
				authority = shared
			}
			return new ProviderAuthenticationSession(
				AbortSignal.any([current.lease.signal, authority]),
				authority,
				current.status.id,
				providerSession,
				current.lease,
				step,
				deadlineTimer,
			)
		} catch (error) {
			clearTimeout(deadlineTimer)
			try {
				providerSession?.[Symbol.dispose]()
			} finally {
				current.lease.dispose()
			}
			this.auditFailure('provider_open_error', error)
			return new FixedAuthenticationSession(
				request.signal,
				rootAuthority,
				'unavailable',
				failedStep('access_unavailable'),
			)
		}
	}

	/** Internal HTTP artifact/file gate. Dynamic Management authority never uses this path. */
	async admit(request: Request, local: boolean, secure: boolean): Promise<AdminAccessAdmission> {
		if (local) return localRecovery(request.signal)
		if (!secure) return denied('secure_transport_required', request.signal)
		const session = await this.openSession(request, false, true)
		const step = await session.state()
		if (step.kind !== 'authenticated') {
			session.release()
			return denied(authenticationReason(step), request.signal)
		}
		return Object.freeze({
			state: Object.freeze({
				allow: true,
				method: 'provider',
				principal: providerPrincipal(step.principal, session.providerId),
			}),
			signal: session.signal,
			release: () => session.release(),
		})
	}

	/** Serve only the three browser-hard auth handoff endpoints. */
	async handleEntryRequest(request: Request, local: boolean, secure: boolean): Promise<Response> {
		const path = new URL(request.url).pathname
		const method = request.method.toUpperCase()
		const operation =
			path === ADMIN_ACCESS_OIDC_START_PATH && method === 'GET'
				? 'oidcStart'
				: path === ADMIN_ACCESS_OIDC_CALLBACK_PATH && method === 'GET'
					? 'oidcCallback'
					: path === ADMIN_ACCESS_COOKIE_COMMIT_PATH && method === 'POST'
						? 'commitCookie'
						: undefined
		if (!operation) return new Response('Not Found', { status: 404, headers: noStoreHeaders() })
		if (!local && !secure) {
			return new Response('Secure transport required', {
				status: 403,
				headers: noStoreHeaders(),
			})
		}

		let current: ActiveProvider | undefined
		try {
			current = this.currentProvider(request.signal)
		} catch {
			return unavailableResponse()
		}
		if (!current?.status.ready) {
			current?.lease.dispose()
			return unavailableResponse()
		}
		const handler = current.registration.provider[operation]
		if (typeof handler !== 'function') {
			current.lease.dispose()
			return new Response('Not Found', { status: 404, headers: noStoreHeaders() })
		}

		try {
			const response = await handler.call(
				current.registration.provider,
				providerRequest(request, current.lease.signal, operation === 'commitCookie'),
				Object.freeze({ local, secure }),
			)
			if (!(response instanceof Response))
				throw new TypeError(`${operation} must return a Response`)
			if (current.lease.signal.aborted) {
				void response.body?.cancel(current.lease.signal.reason).catch((): undefined => undefined)
				current.lease.dispose()
				return unavailableResponse()
			}
			return responseWithLease(withNoStore(response), current.lease)
		} catch (error) {
			current.lease.dispose()
			this.auditFailure(`${operation}_error`, error)
			return unavailableResponse()
		}
	}

	/** @internal Called only by the owner-bound public facade. */
	provideFor(
		owner: PluxelContext,
		provider: ManagementAccessProvider,
	): ManagementAccessRegistration {
		if (!owner.pluginInfo) throw new TypeError('Management provider owner must be a Plugin')
		if (
			!provider ||
			typeof provider.status !== 'function' ||
			typeof provider.open !== 'function' ||
			(provider.oidcStart !== undefined && typeof provider.oidcStart !== 'function') ||
			(provider.oidcCallback !== undefined && typeof provider.oidcCallback !== 'function') ||
			(provider.commitCookie !== undefined && typeof provider.commitCookie !== 'function')
		) {
			throw new TypeError('[pluxel/runtime] Invalid Management access provider')
		}
		for (const current of this.registrations) {
			if (current.owner === owner) {
				throw new Error('[pluxel/runtime] Plugin generation already provided Management access')
			}
			if (current.owner.pluginInfo.nodeSlot !== owner.pluginInfo.nodeSlot) {
				throw new Error('[pluxel/runtime] Exactly one Management access provider is supported')
			}
		}

		const withdrawn = new AbortController()
		const registration = Object.freeze({
			owner: owner as PluginContext,
			provider,
			authority: AbortSignal.any([authoritySignal(owner), withdrawn.signal]),
			credentials: new WeakMap<AbortSignal, AbortSignal>(),
		})
		this.registrations.add(registration)
		let active = true
		const cleanup = () => {
			if (!active) return
			active = false
			this.registrations.delete(registration)
			withdrawn.abort(new Error('Management authentication provider was withdrawn'))
		}
		let guard: ReturnType<PluxelContext['effects']['defer']>
		try {
			guard = owner.effects.defer(cleanup, { tag: 'ManagementAccessProvider' })
		} catch (error) {
			cleanup()
			throw error
		}
		return Object.freeze({
			dispose: () => {
				guard.cancel()
				cleanup()
			},
		})
	}

	private currentProvider(callSignal?: AbortSignal): ActiveProvider | undefined {
		for (const registration of this.registrations) {
			if (!this.isCurrent(registration)) continue
			let lease: ResponseLease | undefined
			try {
				lease = enterOwnerInvocation(registration.owner, callSignal)
				return { registration, status: statusSnapshot(registration.provider.status()), lease }
			} catch (error) {
				lease?.dispose()
				this.auditFailure('status_error', error)
				throw error
			}
		}
		return undefined
	}

	private isCurrent(registration: ProviderRegistration): boolean {
		const instance = requirePluginService(this.ctx).getInstance(
			registration.owner.pluginInfo.nodeSlot,
		)
		return instance?.ctx === registration.owner
	}

	private auditFailure(reason: string, error: unknown): void {
		recordSecurityEvent(this.ctx, {
			area: 'adminAccess',
			action: 'authorize',
			status: 'failure',
			reason,
			message:
				error instanceof Error
					? `Management authentication provider failed: ${error.name}`
					: 'Management authentication provider failed.',
		})
	}
}

function assertProviderSession(
	value: unknown,
): asserts value is ManagementAuthenticationProviderSession {
	if (
		!value ||
		typeof value !== 'object' ||
		typeof (value as ManagementAuthenticationProviderSession).state !== 'function' ||
		typeof (value as ManagementAuthenticationProviderSession).submit !== 'function' ||
		((value as ManagementAuthenticationProviderSession).logout !== undefined &&
			typeof (value as ManagementAuthenticationProviderSession).logout !== 'function') ||
		typeof (value as ManagementAuthenticationProviderSession)[Symbol.dispose] !== 'function'
	) {
		throw new TypeError('provider open() must return a disposable authentication session')
	}
}

function cookieCommitSnapshot(value: unknown): ManagementAuthenticationCookieCommit {
	const commit = readRecord(value, 'cookie commit ticket')
	assertExactKeys(commit, ['ticket', 'expiresAt'], 'cookie commit ticket')
	const ticket = boundedText(commit.ticket, 4096)
	if (!ticket || !Number.isSafeInteger(commit.expiresAt) || Number(commit.expiresAt) <= 0) {
		throw new TypeError('cookie commit ticket is invalid')
	}
	return Object.freeze({ ticket, expiresAt: Number(commit.expiresAt) })
}

function providerPrincipal(
	principal: Readonly<{ subject: string; displayName?: string }>,
	provider: string,
): AdminAccessPrincipal {
	return Object.freeze({
		provider,
		subject: principal.subject,
		...(principal.displayName ? { displayName: principal.displayName } : {}),
	})
}

function authenticationReason(step: ManagementAuthenticationProviderStep): AdminAccessReason {
	if (step.kind === 'challenge' || step.kind === 'navigate') return 'authentication_required'
	if (step.kind === 'failed') {
		switch (step.code) {
			case 'authentication_failed':
				return 'invalid_credentials'
			case 'access_unavailable':
				return 'authentication_unavailable'
			default:
				return 'authentication_required'
		}
	}
	return 'authentication_unavailable'
}

function denied(reason: AdminAccessReason, signal: AbortSignal): AdminAccessAdmission {
	return Object.freeze({
		state: Object.freeze({ allow: false, reason }),
		signal,
		release: NOOP_RELEASE,
	})
}

function localRecovery(signal: AbortSignal): AdminAccessAdmission {
	return Object.freeze({
		state: Object.freeze({ allow: true, method: 'local' }),
		signal,
		release: NOOP_RELEASE,
	})
}

function inputBytes(input: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(input)).byteLength
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

function noStoreHeaders(): HeadersInit {
	return { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
}

function unavailableResponse(): Response {
	return new Response('Authentication unavailable', {
		status: 503,
		headers: noStoreHeaders(),
	})
}

function withNoStore(response: Response): Response {
	const headers = new Headers(response.headers)
	headers.set('cache-control', 'no-store')
	headers.set('x-content-type-options', 'nosniff')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
