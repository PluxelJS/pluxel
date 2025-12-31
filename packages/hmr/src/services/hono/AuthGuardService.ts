import { type Context, Injectable } from '@pluxel/core'

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
	/**
	 * 未登录/未通过验证时的跳转路径（例如 /login）。
	 * - UI 请求会 302
	 * - API/GraphQL 会返回 401 + redirectPath 供客户端处理
	 */
	redirectPath: string
	/** 同步或异步鉴权：true 放行，false 拒绝 */
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
	private readonly logger: NonNullable<Context['logger']>

	constructor(public ctx: Context) {
		this.logger = ctx.logger!
	}

	register(reg: AuthGuardRegistration): () => void {
		if (!reg?.authorize) {
			throw new Error('[AuthGuardService] register({ authorize }) is required.')
		}
		if (!reg?.redirectPath) {
			throw new Error('[AuthGuardService] register({ redirectPath }) is required.')
		}

		const pluginId = this.ctx.pluginInfo.id
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

		active.removeFromScope = this.ctx.scope.collectEffect(() => this.clearGuard(active))
		this.guard = active

		this.logger.info(existing ? '[AuthGuard] Guard updated' : '[AuthGuard] Guard registered', {
			pluginName: pluginId,
		})

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

	/** 统一入口：插件抛错视为拒绝（更安全）。 */
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
		} catch (err: any) {
			this.logger.error('[AuthGuard] Guard threw', {
				pluginName: active.pluginName,
				kind: input.kind,
				path: input.path,
				method: input.method,
				reason: err?.message ?? String(err),
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
			this.logger.info('[AuthGuard] Guard unregistered', { pluginName: current.pluginName })
		}
	}
}
