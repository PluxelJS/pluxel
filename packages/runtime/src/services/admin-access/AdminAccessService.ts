import type { Context as PluxelContext, PluginContext } from '@pluxel/core'
import { enterOwnerInvocation, requirePluginService } from '@pluxel/core/internal'
import { pinOwnerContext } from '../../context/owner-view'
import { recordSecurityEvent } from '../security/audit'
import { ADMIN_ACCESS_PAGE_PATH } from './transport'
import { responseWithLease, type ResponseLease } from './response-lifetime'
import type {
	AdminAccessAuthorizeInput,
	AdminAccessEntryState,
	AdminAccessOverview,
	AdminAccessReason,
	AdminAccessState,
	ManagementAccessProvider,
	ManagementAccessProviderDecision,
	ManagementAccessProviderStatus,
	ManagementAccessRegistration,
} from './types'

type ProviderRegistration = Readonly<{
	owner: PluginContext
	provider: ManagementAccessProvider
}>

export type AdminAccessAdmission = Readonly<{
	state: AdminAccessState
	signal: AbortSignal
	release(): void
}>

type ActiveProvider = Readonly<{
	registration: ProviderRegistration
	status: ManagementAccessProviderStatus
	lease: ResponseLease
}>

const NOOP_RELEASE = (): void => undefined

function managementRequest(request: Request, signal: AbortSignal): Request {
	const headers = new Headers(request.headers)
	headers.delete('content-length')
	headers.delete('transfer-encoding')
	return new Request(request.url, {
		method: request.method,
		headers,
		signal,
	})
}

function providerEntryRequest(request: Request, signal: AbortSignal): Request {
	const source = new URL(request.url)
	const suffix = source.pathname.slice(ADMIN_ACCESS_PAGE_PATH.length)
	source.pathname = suffix || '/'
	return new Request(source, {
		method: request.method,
		headers: request.headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
		signal,
		...(request.method !== 'GET' && request.method !== 'HEAD' && request.body
			? { duplex: 'half' }
			: {}),
	} as RequestInit)
}

function statusSnapshot(value: unknown): ManagementAccessProviderStatus {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('provider status must be an object')
	}
	const input = value as Partial<ManagementAccessProviderStatus>
	const id = typeof input.id === 'string' ? input.id.trim() : ''
	const label = typeof input.label === 'string' ? input.label.trim() : ''
	if (!id || id.length > 128 || !/^[a-zA-Z0-9@._:/-]+$/.test(id)) {
		throw new TypeError('provider status.id is invalid')
	}
	if (!label || label.length > 128) throw new TypeError('provider status.label is invalid')
	if (input.method !== 'oidc' && input.method !== 'password' && input.method !== 'password-totp') {
		throw new TypeError('provider status.method is invalid')
	}
	if (typeof input.ready !== 'boolean') throw new TypeError('provider status.ready is invalid')
	return Object.freeze({ id, label, method: input.method, ready: input.ready })
}

function decisionSnapshot(value: unknown): ManagementAccessProviderDecision {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('provider decision must be an object')
	}
	const input = value as Partial<ManagementAccessProviderDecision> & {
		principal?: { subject?: unknown; displayName?: unknown }
		reason?: unknown
	}
	if (input.allow === true) {
		const subject =
			typeof input.principal?.subject === 'string' ? input.principal.subject.trim() : ''
		if (!subject || subject.length > 512) throw new TypeError('provider principal is invalid')
		const displayName =
			typeof input.principal?.displayName === 'string'
				? input.principal.displayName.trim()
				: undefined
		if (displayName && displayName.length > 256) {
			throw new TypeError('provider principal display name is invalid')
		}
		return Object.freeze({
			allow: true,
			principal: Object.freeze({ subject, ...(displayName ? { displayName } : {}) }),
		})
	}
	if (input.allow !== false) throw new TypeError('provider decision.allow is invalid')
	if (
		input.reason !== 'unavailable' &&
		input.reason !== 'unauthenticated' &&
		input.reason !== 'invalid_credentials' &&
		input.reason !== 'forbidden' &&
		input.reason !== 'secure_transport_required'
	) {
		throw new TypeError('provider decision.reason is invalid')
	}
	return Object.freeze({ allow: false, reason: input.reason })
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

function decisionReason(
	reason: Exclude<ManagementAccessProviderDecision, { allow: true }>['reason'],
): AdminAccessReason {
	switch (reason) {
		case 'unavailable':
			return 'authentication_unavailable'
		case 'unauthenticated':
			return 'authentication_required'
		default:
			return reason
	}
}

/** Runtime-owned, fail-closed gate for the Management Plane. */
export class AdminAccessService {
	private readonly registrations = new Set<ProviderRegistration>()

	constructor(public readonly ctx: PluxelContext) {
		pinOwnerContext(this, ctx)
	}

	/** Conservative public check: locality is never accepted from a caller-provided value. */
	async authorize(input: AdminAccessAuthorizeInput = {}): Promise<AdminAccessState> {
		const request = input.request ?? new Request('http://pluxel.invalid/')
		const admission = await this.admit(request, false, false)
		admission.release()
		return admission.state
	}

	async describe(_input: AdminAccessAuthorizeInput = {}): Promise<AdminAccessOverview> {
		let current: ActiveProvider | undefined
		try {
			current = this.currentProvider()
		} catch {
			return Object.freeze({ policy: 'provider-or-local-recovery', provider: null })
		}
		if (!current) {
			return Object.freeze({ policy: 'provider-or-local-recovery', provider: null })
		}
		current.lease.dispose()
		return Object.freeze({ policy: 'provider-or-local-recovery', provider: current.status })
	}

	/** @internal The HTTP ingress is the only caller allowed to supply trusted locality. */
	async admit(request: Request, local: boolean, secure: boolean): Promise<AdminAccessAdmission> {
		let current: ActiveProvider | undefined
		try {
			current = this.currentProvider(request.signal)
		} catch {
			return local
				? localRecovery(request.signal)
				: denied('authentication_unavailable', request.signal)
		}
		const active = current?.status.ready ? current : undefined
		if (current && !active) current.lease.dispose()
		if (!active) {
			return local ? localRecovery(request.signal) : denied('local_setup_required', request.signal)
		}
		if (!local && !secure) {
			active.lease.dispose()
			return denied('secure_transport_required', request.signal)
		}
		let decision: ManagementAccessProviderDecision
		try {
			decision = decisionSnapshot(
				await active.registration.provider.authorize(
					managementRequest(request, active.lease.signal),
					Object.freeze({ local, secure }),
				),
			)
		} catch (error) {
			active.lease.dispose()
			this.auditFailure('provider_error', error)
			return denied('authentication_unavailable', request.signal)
		}

		if (!this.isCurrent(active.registration) || active.lease.signal.aborted) {
			active.lease.dispose()
			return denied('authentication_unavailable', request.signal)
		}
		if (decision.allow === false) {
			active.lease.dispose()
			return denied(decisionReason(decision.reason), request.signal)
		}
		return Object.freeze({
			state: Object.freeze({
				allow: true,
				method: 'provider',
				principal: Object.freeze({
					provider: active.status.id,
					subject: decision.principal.subject,
					...(decision.principal.displayName
						? { displayName: decision.principal.displayName }
						: {}),
				}),
			}),
			signal: active.lease.signal,
			release: () => active.lease.dispose(),
		})
	}

	/** @internal Serve the sole unauthenticated Management entry point. */
	async handleEntryRequest(
		request: Request,
		local: boolean,
		secure: boolean,
		listenerPort: number,
	): Promise<Response> {
		const path = new URL(request.url).pathname
		let current: ActiveProvider | undefined
		try {
			current = this.currentProvider(request.signal)
		} catch {
			if (local) {
				if (path === `${ADMIN_ACCESS_PAGE_PATH}/state`) {
					return Response.json({ state: 'allowed' } satisfies AdminAccessEntryState, {
						headers: entryHeaders('application/json; charset=utf-8'),
					})
				}
				return localWorkbenchRedirect(request)
			}
			if (path === `${ADMIN_ACCESS_PAGE_PATH}/state`) {
				return Response.json(
					{ state: 'authentication_unavailable' } satisfies AdminAccessEntryState,
					{ headers: entryHeaders('application/json; charset=utf-8') },
				)
			}
			return new Response(renderAuthenticationUnavailable(), {
				status: 503,
				headers: entryHeaders('text/html; charset=utf-8'),
			})
		}
		const providerReady = current?.status.ready === true
		if (current && providerReady && !local && !secure) {
			current.lease.dispose()
			if (path === `${ADMIN_ACCESS_PAGE_PATH}/state`) {
				return Response.json(
					{ state: 'secure_transport_required' } satisfies AdminAccessEntryState,
					{ headers: entryHeaders('application/json; charset=utf-8') },
				)
			}
			return new Response(renderSecureTransportRequired(), {
				status: 403,
				headers: entryHeaders('text/html; charset=utf-8'),
			})
		}
		const active = current && (local || providerReady) ? current : undefined
		if (current && !active) current.lease.dispose()
		if (path === `${ADMIN_ACCESS_PAGE_PATH}/state`) {
			const state = await this.entryState(request, local, secure, active)
			return Response.json(state, { headers: entryHeaders('application/json; charset=utf-8') })
		}
		if (active) {
			let transferred = false
			try {
				const response = await active.registration.provider.handle(
					providerEntryRequest(request, active.lease.signal),
					Object.freeze({ local, secure }),
				)
				if (response) {
					if (!(response instanceof Response)) {
						throw new TypeError('provider handle must return a Response or undefined')
					}
					if (!this.isCurrent(active.registration) || active.lease.signal.aborted) {
						void response.body?.cancel(active.lease.signal.reason).catch((): undefined => undefined)
						return new Response(renderAuthenticationUnavailable(), {
							status: 503,
							headers: entryHeaders('text/html; charset=utf-8'),
						})
					}
					const leasedResponse = responseWithLease(response, active.lease)
					transferred = true
					return leasedResponse
				}
			} catch (error) {
				this.auditFailure('entry_error', error)
			} finally {
				if (!transferred) active.lease.dispose()
			}
		}
		if (local && !providerReady) return localWorkbenchRedirect(request)
		if (active) {
			return new Response(renderAuthenticationUnavailable(), {
				status: 503,
				headers: entryHeaders('text/html; charset=utf-8'),
			})
		}
		return new Response(renderLocalSetupRequired(listenerPort, secure), {
			status: 403,
			headers: entryHeaders('text/html; charset=utf-8'),
		})
	}

	private async entryState(
		request: Request,
		local: boolean,
		secure: boolean,
		current: ActiveProvider | undefined,
	): Promise<AdminAccessEntryState> {
		if (!current?.status.ready) {
			current?.lease.dispose()
			return local ? { state: 'allowed' } : { state: 'local_setup_required' }
		}
		try {
			const decision = decisionSnapshot(
				await current.registration.provider.authorize(
					managementRequest(request, current.lease.signal),
					Object.freeze({ local, secure }),
				),
			)
			if (!this.isCurrent(current.registration) || current.lease.signal.aborted) {
				return { state: 'authentication_unavailable' }
			}
			if (decision.allow === true) return { state: 'allowed' }
			return decision.reason === 'unavailable'
				? { state: 'authentication_unavailable' }
				: { state: 'login_required', method: current.status.method }
		} catch (error) {
			this.auditFailure('state_error', error)
			return { state: 'authentication_unavailable' }
		} finally {
			current.lease.dispose()
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
			typeof provider.authorize !== 'function' ||
			typeof provider.handle !== 'function'
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

		const registration = Object.freeze({ owner: owner as PluginContext, provider })
		this.registrations.add(registration)
		let active = true
		const cleanup = () => {
			if (!active) return
			active = false
			this.registrations.delete(registration)
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
				const status = statusSnapshot(registration.provider.status())
				return { registration, status, lease }
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

function localWorkbenchRedirect(request: Request): Response {
	return new Response(null, {
		status: 303,
		headers: { ...entryHeaders(), location: sanitizeReturnTo(request) },
	})
}

function sanitizeReturnTo(request: Request): string {
	const current = new URL(request.url)
	const raw = current.searchParams.get('returnTo')
	if (!raw || raw.includes('\\')) return '/'
	try {
		const resolved = new URL(raw, current)
		if (resolved.origin !== current.origin) return '/'
		if (resolved.pathname.startsWith(ADMIN_ACCESS_PAGE_PATH)) return '/'
		return `${resolved.pathname}${resolved.search}${resolved.hash}`
	} catch {
		return '/'
	}
}

function entryHeaders(contentType?: string): Record<string, string> {
	return {
		'cache-control': 'no-store',
		'content-security-policy':
			"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		...(contentType ? { 'content-type': contentType } : {}),
	}
}

function renderLocalSetupRequired(listenerPort: number, secure: boolean): string {
	const port =
		Number.isInteger(listenerPort) && listenerPort > 0 && listenerPort <= 65_535
			? listenerPort
			: 3_000
	const protocol = secure ? 'https' : 'http'
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pluxel local setup required</title><style>
:root{color-scheme:light;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f8;color:#18232c}main{width:min(560px,calc(100vw - 32px));padding:28px;border:1px solid #d8dee3;border-radius:12px;background:#fff;box-shadow:0 16px 48px #18232c1a}h1{margin:0 0 12px;font-size:24px}p{line-height:1.55;color:#46545f}code{display:block;overflow:auto;padding:12px;border-radius:8px;background:#eef2f5;color:#18232c}</style></head>
<body><main><h1>Local setup required</h1><p>No active authentication provider is available. Remote Management access is closed.</p><p>Connect to this host with SSH, create a loopback tunnel, then configure and start the official authentication plugin from the local Workbench.</p><code>ssh -L ${port}:127.0.0.1:${port} user@host</code><p>Open <strong>${protocol}://127.0.0.1:${port}</strong> after the tunnel is connected.</p></main></body></html>`
}

function renderAuthenticationUnavailable(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authentication unavailable</title></head><body><main><h1>Authentication unavailable</h1><p>The configured Management authentication provider is temporarily unavailable. Try again later.</p></main></body></html>`
}

function renderSecureTransportRequired(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure connection required</title></head><body><main><h1>Secure connection required</h1><p>Remote Management authentication is available only over HTTPS.</p></main></body></html>`
}
