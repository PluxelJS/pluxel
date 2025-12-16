import { type Context, Injectable } from '@pluxel/core'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

const serviceName = 'authGuard' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: AuthGuardService
	}
}

/** 插件可返回 boolean 或部分字段的对象；内部会做归一化 */
export type AuthGuardDecision =
	| boolean
	| {
			allow?: boolean
			reason?: string
			status?: ContentfulStatusCode
	  }

export interface AuthGuardContext {
	path: string
	method: string
	headers: Headers
	request?: Request
	url?: string
}

export interface AuthGuardRegistration {
	/** 被拒绝时建议前端跳转到的路径（统一入口） */
	redirectPath: string
	/** 同步或异步检查器 */
	check: (ctx: AuthGuardContext) => Promise<AuthGuardDecision> | AuthGuardDecision
}

export type AuthGuardResult =
	| { allow: true }
	| {
			allow: false
			pluginName: string
			reason?: string
			redirectPath: string
			status?: ContentfulStatusCode
	  }

export interface AuthGuardCheckInput {
	path: string
	method?: string
	headers?: Headers
	request?: Request
	url?: string
}

type ActiveGuard = AuthGuardRegistration & {
	pluginName: string
	removeFromScope: () => void
}

@Injectable({ key: serviceName })
export class AuthGuardService {
	private guard: ActiveGuard | undefined
	private readonly logger: NonNullable<Context['logger']>

	constructor(private readonly ctx: Context) {
		this.logger = ctx.logger!
	}

	/**
	 * 注册/更新当前插件的 Guard。
	 * - 不允许覆盖其他插件的 Guard；
	 * - 同插件重复注册视为“更新”；
	 * - 返回取消函数（随 scope 自动回收）。
	 */
	registerGuard(reg: AuthGuardRegistration): () => void {
		if (!reg.redirectPath) {
			throw new Error('[AuthGuardService] redirectPath is required when registering a guard.')
		}

		const pluginId = this.ctx.pluginInfo?.id ?? this.ctx.name
		const existing = this.guard

		if (existing && existing.pluginName !== pluginId) {
			throw new Error(
				`[AuthGuardService] Guard already registered by ${existing.pluginName}. Wait it to unload before registering a new guard.`,
			)
		}

		// 同插件"更新"——先静默清理，避免闪烁日志与多次同步
		if (existing) {
			this.clearGuard(existing, { skipSync: true, silent: true })
		}

		const active: ActiveGuard = {
			...reg,
			pluginName: pluginId,
			removeFromScope: () => {},
		}

		// 与插件生命周期绑定：卸载/热更时自动撤销
		active.removeFromScope = this.ctx.scope.collectEffect(() => this.clearGuard(active))

		this.guard = active
		this.logger.info(existing ? '[AuthGuard] Guard updated' : '[AuthGuard] Guard registered', {
			pluginName: pluginId,
		})

		this.syncHonoGuardState()
		return () => this.clearGuard(active)
	}

	unregisterGuard(): void {
		this.clearGuard()
	}

	isActive(): boolean {
		return !!this.guard
	}

	/**
	 * 统一入口：将“可能不完整”的输入补齐，并调用 Guard。
	 * Guard 抛错时按拒绝处理（更安全），日志记录具体原因。
	 */
	async check(input: AuthGuardCheckInput): Promise<AuthGuardResult> {
		const active = this.guard
		if (!active) return { allow: true }

		const method = (input.method ?? input.request?.method ?? 'GET').toUpperCase()
		const headers =
			input.headers ??
			(input.request?.headers instanceof Headers
				? input.request.headers
				: new Headers(input.request?.headers))

		const ctx: AuthGuardContext = {
			path: input.path,
			method,
			headers,
		}
		if (input.request) ctx.request = input.request
		if (input.url) ctx.url = input.url

		let decision: AuthGuardDecision
		try {
			decision = await active.check(ctx)
		} catch (err: any) {
			this.logger.error('[AuthGuard] Guard check threw', {
				pluginName: active.pluginName,
				path: ctx.path,
				method: ctx.method,
				reason: err?.message ?? String(err),
			})
			// 抛错视为拒绝更安全；前端可拿到 redirectPath 统一跳转
			return {
				allow: false,
				pluginName: active.pluginName,
				redirectPath: active.redirectPath,
				reason: 'guard_threw',
				status: 403 as ContentfulStatusCode,
			}
		}

		return this.buildResult(active, decision)
	}

	// —— 内部实现 —— //

	private buildResult(guard: ActiveGuard, decision: AuthGuardDecision): AuthGuardResult {
		// 宽容输入：null/undefined 视为允许
		if (decision == null || decision === true) return { allow: true }
		if (decision === false) {
			return {
				allow: false,
				pluginName: guard.pluginName,
				redirectPath: guard.redirectPath,
			}
		}

		// 对象场景：默认 allow=false 除非显式 allow===true
		const allow = !!(decision as any).allow
		if (allow) return { allow: true }

		const reason = (decision as any).reason as string | undefined
		const status = (decision as any).status as ContentfulStatusCode | undefined

		const result: AuthGuardResult = {
			allow: false,
			pluginName: guard.pluginName,
			redirectPath: guard.redirectPath,
		}
		if (reason !== undefined) result.reason = reason
		if (status !== undefined) result.status = status
		return result
	}

	/** 通知 HonoService：是否需要对 /api/* 套上守卫 */
	private syncHonoGuardState() {
		// HonoService 可能尚未构造完成；此处只做尽力同步
		this.ctx.honoService.switchAuthGuard(this.guard !== undefined)
	}

	private clearGuard(expected?: ActiveGuard, opts?: { skipSync?: boolean; silent?: boolean }) {
		const current = this.guard
		if (!current) return
		if (expected && current !== expected) return

		current.removeFromScope()
		current.removeFromScope = () => {}

		this.guard = undefined
		if (!opts?.silent) {
			this.logger.info('[AuthGuard] Guard unregistered', { pluginName: current.pluginName })
		}
		if (!opts?.skipSync) {
			this.syncHonoGuardState()
		}
	}
}
