import { type Context as PluxelContext, Injectable } from '@pluxel/core'

const serviceName = 'authGuard' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: AuthGuardService
		}
	}
}

export type AuthGuardKind = 'ui' | 'api' | 'graphql'

export interface AuthGuardContext {
	kind: AuthGuardKind
	path: string
	method: string
	url: string
	headers: Headers
	request: Request
}

export interface AuthGuardRegistration {
	redirectPath: string
	authorize: (ctx: AuthGuardContext) => Promise<boolean> | boolean
}

export type AuthGuardResult =
	| { allow: true }
	| {
			allow: false
			pluginName: string
			redirectPath: string
	  }

type ActiveGuard = AuthGuardRegistration & {
	pluginName: string
	removeFromScope: () => void
}

@Injectable({ key: serviceName })
export class AuthGuardService {
	private guard: ActiveGuard | undefined
	private readonly logger: NonNullable<PluxelContext['logger']>

	constructor(public ctx: PluxelContext) {
		this.logger = ctx.logger!
	}

	register(reg: AuthGuardRegistration): () => void {
		if (!reg?.authorize) {
			throw new Error('[AuthGuardService] register({ authorize }) is required.')
		}
		if (!reg?.redirectPath) {
			throw new Error('[AuthGuardService] register({ redirectPath }) is required.')
		}

		const pluginId = this.ctx.pluginInfo?.id ?? 'unknown'
		const existing = this.guard

		if (existing && existing.pluginName !== pluginId) {
			throw new Error(
				`[AuthGuardService] Guard already registered by ${existing.pluginName}. Wait it to unload before registering a new guard.`,
			)
		}

		if (existing) {
			this.clearGuard(existing, { silent: true })
		}

		const active: ActiveGuard = {
			pluginName: pluginId,
			redirectPath: reg.redirectPath,
			authorize: reg.authorize,
			removeFromScope: () => {},
		}

		const scope = this.ctx.effects.defer(() => this.clearGuard(active))
		active.removeFromScope = () => scope.cancel()
		this.guard = active

		this.logger.info(existing ? 'Guard updated' : 'Guard registered')

		return () => this.clearGuard(active)
	}

	unregister(): void {
		this.clearGuard()
	}

	isActive(): boolean {
		return !!this.guard
	}

	getActivePluginName(): string | undefined {
		return this.guard?.pluginName
	}

	getRedirectPath(): string | undefined {
		return this.guard?.redirectPath
	}

	async check(input: AuthGuardContext): Promise<AuthGuardResult> {
		const active = this.guard
		if (!active) return { allow: true }

		try {
			const allow = await active.authorize(input)
			if (allow) return { allow: true }
			return {
				allow: false,
				pluginName: active.pluginName,
				redirectPath: active.redirectPath,
			}
		} catch (error) {
			this.logger.error('Guard threw', {
				error,
				pluginId: active.pluginName,
				kind: input.kind,
				path: input.path,
				method: input.method,
				reason: error instanceof Error ? error.message : String(error),
			})
			return {
				allow: false,
				pluginName: active.pluginName,
				redirectPath: active.redirectPath,
			}
		}
	}

	private clearGuard(expected?: ActiveGuard, opts?: { silent?: boolean }) {
		const current = this.guard
		if (!current) return
		if (expected && current !== expected) return

		current.removeFromScope()
		current.removeFromScope = () => {}
		this.guard = undefined

		if (!opts?.silent) {
			this.logger.info('Guard unregistered', { pluginId: current.pluginName })
		}
	}
}
