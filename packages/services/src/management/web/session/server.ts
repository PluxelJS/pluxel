import { newWebSocketRpcSession, RpcTarget, type RpcStub } from 'capnweb'
import {
	providerStepSnapshot,
	type AdminAuthenticationSession,
} from '../../services/admin-access/AdminAccessService'
import type { RuntimeManagementTarget } from '../management-target'
import type {
	AdminAccessPrincipal,
	ManagementAuthenticationProviderStep,
} from '../../services/admin-access/types'
import {
	RUNTIME_SESSION_PROFILE,
	type RuntimeLogoutResult,
	type RuntimeAuthenticationTarget,
	type RuntimeBootstrap,
	type RuntimeSessionEvent,
	type RuntimeSessionInvalidationCause,
	type RuntimeSessionObserver,
	type RuntimeSessionRoot,
} from './protocol'
import { RuntimeSessionWebSocket } from './elysia-websocket'
import { parseRuntimeLogoutResult } from './validation'

const invalidateFromHost = Symbol('invalidateFromHost')

const OBSERVER_DEADLINE_MS = 250

export type RuntimeSessionFactories = Readonly<{
	createManagement(session: Readonly<{ signal: AbortSignal }>): RuntimeManagementTarget
	createWorkbench?(
		principal: AdminAccessPrincipal,
		invalidate: (cause: Error) => void,
	): Readonly<{ target: RpcTarget; dispose(): void }>
	onError(error: unknown): void
}>

export type RuntimeSessionServerOptions = RuntimeSessionFactories &
	Readonly<{
		authentication: AdminAuthenticationSession
		socket: RuntimeSessionWebSocket
	}>

/** Owns one Cap'n Web object graph for exactly one physical control socket. */
export class RuntimeSessionServer implements Disposable {
	private readonly root: RuntimeSessionRootTarget
	private readonly remoteRoot: RpcStub<RpcTarget>
	private disposed = false

	constructor(options: RuntimeSessionServerOptions) {
		this.root = new RuntimeSessionRootTarget(options, (code, reason) =>
			options.socket.close(code, reason),
		)
		try {
			this.remoteRoot = newWebSocketRpcSession<RpcTarget>(options.socket.webSocket, this.root, {
				onSendError: (error) => {
					options.onError(error)
					return new Error('Runtime control operation failed')
				},
			})
		} catch (error) {
			this.root[Symbol.dispose]()
			throw error
		}
	}

	invalidate(cause: RuntimeSessionInvalidationCause): void {
		if (this.disposed) return
		this.root[invalidateFromHost](cause)
	}

	[Symbol.dispose](): void {
		if (this.disposed) return
		this.disposed = true
		this.root[Symbol.dispose]()
		this.remoteRoot[Symbol.dispose]()
	}
}

class RuntimeAuthenticationTargetImpl extends RpcTarget implements RuntimeAuthenticationTarget {
	private active = true

	constructor(private readonly session: AdminAuthenticationSession) {
		super()
	}

	async stateDto(): Promise<ManagementAuthenticationProviderStep> {
		return this.active
			? providerStepSnapshot(await this.session.state())
			: Object.freeze({ kind: 'failed', code: 'authentication_expired' })
	}

	async submitDto(input: unknown): Promise<ManagementAuthenticationProviderStep> {
		return this.active
			? providerStepSnapshot(await this.session.submit(input))
			: Object.freeze({ kind: 'failed', code: 'authentication_expired' })
	}

	[Symbol.dispose](): void {
		this.active = false
	}
}

class RuntimeSessionRootTarget extends RpcTarget implements RuntimeSessionRoot {
	private readonly authenticationTarget: RuntimeAuthenticationTargetImpl
	private observer?: RpcStub<RuntimeSessionObserver>
	private management?: RuntimeManagementTarget
	private readonly scope = new AbortController()
	private workbenchSession?: ReturnType<NonNullable<RuntimeSessionFactories['createWorkbench']>>
	private authenticationDelivered = false
	private readyDelivered = false
	private active = true
	private invalidating = false
	private authenticationReleased = false

	constructor(
		private readonly options: RuntimeSessionServerOptions,
		private readonly closeConnection: (code: number, reason: string) => void,
	) {
		super()
		this.authenticationTarget = new RuntimeAuthenticationTargetImpl(options.authentication)
		options.authentication.signal.addEventListener('abort', this.authenticationInvalidated, {
			once: true,
		})
	}

	async bootstrap(observer: RpcStub<RuntimeSessionObserver>): Promise<RuntimeBootstrap> {
		this.#assertActive()
		this.#retainObserver(observer)
		const step = await this.options.authentication.state()
		this.#assertActive()

		if (step.kind !== 'authenticated') {
			if (this.authenticationDelivered) {
				throw new Error('Authentication bootstrap was already delivered')
			}
			this.authenticationDelivered = true
			return Object.freeze({
				kind: 'authentication-required',
				profile: RUNTIME_SESSION_PROFILE,
				authentication: this.authenticationTarget,
			})
		}

		if (this.readyDelivered) throw new Error('Ready bootstrap was already delivered')
		this.readyDelivered = true
		const management = (this.management ??= this.options.createManagement({
			signal: AbortSignal.any([this.scope.signal, this.options.authentication.signal]),
		}))
		if (!this.options.createWorkbench) {
			return Object.freeze({
				kind: 'management',
				profile: RUNTIME_SESSION_PROFILE,
				management,
			})
		}

		const principal = Object.freeze({
			provider: this.options.authentication.providerId,
			subject: step.principal.subject,
			...(step.principal.displayName === undefined
				? {}
				: { displayName: step.principal.displayName }),
		})
		const workbench = (this.workbenchSession ??= this.options.createWorkbench(principal, (cause) =>
			this.#invalidate('workbench', cause),
		))
		return Object.freeze({
			kind: 'workbench',
			profile: RUNTIME_SESSION_PROFILE,
			management,
			workbench: workbench.target,
		})
	}

	async logoutDto(): Promise<RuntimeLogoutResult> {
		this.#assertActive()
		const commit = await this.options.authentication.logout()
		this.#assertActive()
		const result: RuntimeLogoutResult = commit
			? Object.freeze({
					kind: 'cookie-commit-required',
					ticket: commit.ticket,
					expiresAt: commit.expiresAt,
				})
			: Object.freeze({ kind: 'closed' })
		const timer = setTimeout(
			() => this.#invalidate('authentication', new Error('Management session logged out')),
			0,
		)
		timer.unref?.()
		return parseRuntimeLogoutResult(result)
	}

	[Symbol.dispose](): void {
		if (!this.active && !this.invalidating) return
		this.active = false
		this.scope.abort(new Error('Management session is no longer active'))
		this.invalidating = false
		this.options.authentication.signal.removeEventListener('abort', this.authenticationInvalidated)
		this.authenticationTarget[Symbol.dispose]()
		this.workbenchSession?.dispose()
		this.workbenchSession = undefined
		this.#releaseAuthentication()
		this.observer?.[Symbol.dispose]()
		this.observer = undefined
	}

	[invalidateFromHost](cause: RuntimeSessionInvalidationCause): void {
		this.#invalidate(cause, new Error('Runtime session host epoch changed'))
	}

	private readonly authenticationInvalidated = (): void => {
		this.#invalidate('authentication', new Error('Authentication authority changed'))
	}

	#retainObserver(observer: RpcStub<RuntimeSessionObserver>): void {
		if (this.observer) return
		if (!observer || typeof observer !== 'function' || typeof observer.dup !== 'function') {
			throw new TypeError('Runtime session observer must be an RPC callback')
		}
		this.observer = observer.dup()
	}

	#invalidate(cause: RuntimeSessionInvalidationCause, _error: Error): void {
		if (!this.active || this.invalidating) return
		this.invalidating = true
		this.active = false
		this.scope.abort(new Error('Management session is no longer active'))
		this.authenticationTarget[Symbol.dispose]()
		this.workbenchSession?.dispose()
		this.workbenchSession = undefined
		this.#releaseAuthentication()
		void this.#notifyInvalidationAndClose(cause)
	}

	#releaseAuthentication(): void {
		if (this.authenticationReleased) return
		this.authenticationReleased = true
		this.options.authentication.release()
	}

	async #notifyInvalidationAndClose(cause: RuntimeSessionInvalidationCause): Promise<void> {
		const observer = this.observer
		try {
			if (observer) {
				using result = observer(
					Object.freeze({ kind: 'epoch-invalidated', cause }) satisfies RuntimeSessionEvent,
				)
				await Promise.race([result, observerDeadline()])
			}
		} catch {
			// The physical close below is authoritative.
		} finally {
			observer?.[Symbol.dispose]()
			this.observer = undefined
			this.closeConnection(1012, 'Runtime Session Invalidated')
		}
	}

	#assertActive(): void {
		if (!this.active || this.options.authentication.signal.aborted) {
			throw new Error('Runtime session epoch is no longer active')
		}
	}
}

function observerDeadline(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, OBSERVER_DEADLINE_MS)
		timer.unref?.()
	})
}
