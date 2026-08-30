import type { Context } from '@pluxel/core'
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from '../../capnweb'
import { RuntimeManagementTargetImpl } from '../../services/management/RuntimeManagementTarget'
import type { AdminAuthenticationSession } from '../../services/admin-access/AdminAccessService'
import { requireWorkbench, type WorkbenchServerSession } from '../../services/workbench'
import type { ManagementAuthenticationProviderStep } from '../../services/admin-access/types'
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

const OBSERVER_DEADLINE_MS = 250

export type RuntimeSessionServerOptions = Readonly<{
	ctx: Context
	authentication: AdminAuthenticationSession
	workbench: boolean
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
				onSendError: () => new Error('Runtime control operation failed'),
			})
		} catch (error) {
			this.root[Symbol.dispose]()
			throw error
		}
	}

	invalidate(cause: RuntimeSessionInvalidationCause): void {
		if (this.disposed) return
		this.root.invalidateFromHost(cause)
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

	async state(): Promise<ManagementAuthenticationProviderStep> {
		return this.active
			? await this.session.state()
			: Object.freeze({ kind: 'failed', code: 'authentication_expired' })
	}

	async submit(input: unknown): Promise<ManagementAuthenticationProviderStep> {
		return this.active
			? await this.session.submit(input)
			: Object.freeze({ kind: 'failed', code: 'authentication_expired' })
	}

	[Symbol.dispose](): void {
		this.active = false
	}
}

class RuntimeSessionRootTarget extends RpcTarget implements RuntimeSessionRoot {
	private readonly authenticationTarget: RuntimeAuthenticationTargetImpl
	private observer?: RpcStub<RuntimeSessionObserver>
	private management?: RuntimeManagementTargetImpl
	private workbenchSession?: WorkbenchServerSession
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
		this.assertActive()
		this.retainObserver(observer)
		const step = await this.options.authentication.state()
		this.assertActive()

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
		const management = (this.management ??= new RuntimeManagementTargetImpl(this.options.ctx))
		if (!this.options.workbench) {
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
		const workbench = (this.workbenchSession ??= requireWorkbench(this.options.ctx).createSession(
			principal,
			(cause) => this.invalidate('workbench', cause),
		))
		return Object.freeze({
			kind: 'workbench',
			profile: RUNTIME_SESSION_PROFILE,
			management,
			workbench: workbench.target,
		})
	}

	async logout(): Promise<RuntimeLogoutResult> {
		this.assertActive()
		const commit = await this.options.authentication.logout()
		this.assertActive()
		const result: RuntimeLogoutResult = commit
			? Object.freeze({
					kind: 'cookie-commit-required',
					ticket: commit.ticket,
					expiresAt: commit.expiresAt,
				})
			: Object.freeze({ kind: 'closed' })
		const timer = setTimeout(
			() => this.invalidate('authentication', new Error('Management session logged out')),
			0,
		)
		timer.unref?.()
		return result
	}

	[Symbol.dispose](): void {
		if (!this.active && !this.invalidating) return
		this.active = false
		this.invalidating = false
		this.options.authentication.signal.removeEventListener('abort', this.authenticationInvalidated)
		this.authenticationTarget[Symbol.dispose]()
		this.workbenchSession?.dispose()
		this.workbenchSession = undefined
		this.releaseAuthentication()
		this.observer?.[Symbol.dispose]()
		this.observer = undefined
	}

	invalidateFromHost(cause: RuntimeSessionInvalidationCause): void {
		this.invalidate(cause, new Error('Runtime session host epoch changed'))
	}

	private readonly authenticationInvalidated = (): void => {
		this.invalidate('authentication', new Error('Authentication authority changed'))
	}

	private retainObserver(observer: RpcStub<RuntimeSessionObserver>): void {
		if (this.observer) return
		if (!observer || typeof observer !== 'function' || typeof observer.dup !== 'function') {
			throw new TypeError('Runtime session observer must be an RPC callback')
		}
		this.observer = observer.dup()
	}

	private invalidate(cause: RuntimeSessionInvalidationCause, _error: Error): void {
		if (!this.active || this.invalidating) return
		this.invalidating = true
		this.active = false
		this.authenticationTarget[Symbol.dispose]()
		this.workbenchSession?.dispose()
		this.workbenchSession = undefined
		this.releaseAuthentication()
		void this.notifyInvalidationAndClose(cause)
	}

	private releaseAuthentication(): void {
		if (this.authenticationReleased) return
		this.authenticationReleased = true
		this.options.authentication.release()
	}

	private async notifyInvalidationAndClose(cause: RuntimeSessionInvalidationCause): Promise<void> {
		const observer = this.observer
		try {
			if (observer) {
				const result = observer(
					Object.freeze({ kind: 'epoch-invalidated', cause }) satisfies RuntimeSessionEvent,
				)
				try {
					await Promise.race([result, observerDeadline()])
				} finally {
					result[Symbol.dispose]()
				}
			}
		} catch {
			// The physical close below is authoritative.
		} finally {
			observer?.[Symbol.dispose]()
			this.observer = undefined
			this.closeConnection(1012, 'Runtime Session Invalidated')
		}
	}

	private assertActive(): void {
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
