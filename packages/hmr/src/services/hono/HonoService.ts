// src/services/hono/HonoService.ts

import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { Hono } from 'hono'
import { createFactory, type Factory } from 'hono/factory'
import type { Plugin } from 'vite'

import api from '../../api/hono'
import type { RenderHandler } from '../../server/types'
import type { AuthGuardCheckInput, AuthGuardResult, AuthGuardService } from './AuthGuardService'
import type { AppEnv, HonoWithAppEnvType } from './env'

const serviceName = 'honoService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HonoService
	}
}

type AppMod = (app: HonoWithAppEnvType) => void
type GraphQLFetch = (
	req: Request,
	ctx: { hono: import('hono').Context<AppEnv> },
) => Promise<Response>
type GuardSource = 'api' | 'graphql' | 'html'
interface GuardEvaluationContext extends Omit<AuthGuardCheckInput, 'headers'> {
	headers: Headers
	method: string
	source: GuardSource
	context?: Readonly<Record<string, unknown>>
}

// —— Service ————————————————————————————————————————————————————————————
@Injectable({ key: serviceName })
export class HonoService {
	private mods = new Set<AppMod>()

	// 当前活跃的 Hono 应用实例
	private app!: HonoWithAppEnvType

	// fetch 代理指针：保持稳定的函数引用，只更新内部指向
	private fetchPtr: (req: Request, env?: any, ctx?: any) => Response | Promise<Response> = (
		req,
		env,
		ctx,
	) => this.app.fetch(req, env, ctx)

	// HMR / 重建 调度
	private pendingRebuild = false
	private shouldReload = false

	// GraphQL 处理器：函数指针替换，零重建
	private gqlFetch: GraphQLFetch = async () => new Response('GraphQL not ready', { status: 503 })
	private readonly renderer: Promise<RenderHandler>

	private guardEnabled = false
	private authGuardRef?: AuthGuardService
	private readonly logger: NonNullable<Context['logger']>

	constructor(private ctx: Context) {
		this.logger = ctx.logger!
		this.renderer = this.createRenderer()
		this.rebuildApp()
		// 务必调用 scheduleRebuild 而不是 rebui_configno 构建，否则会导致使用默认 gqlFetch
		ctx.graphql.scheduleRebuild()
	}

	/** 将 plugin_ctx 注入到 c.env / 变量表（供外部需要时复用） */
	public createFactory(): Factory<AppEnv, string> {
		return createFactory<AppEnv>({
			initApp: (app) => {
				app.use(async (c, next) => {
					c.set('plugin_ctx', this.ctx)
					await next()
				})
			},
		})
	}

	/** GraphQLService 重织后调用：仅替换函数指针，零重建 Hono 应用 */
	setGraphQLFetch(fn: GraphQLFetch) {
		this.gqlFetch = fn
		this.requestFullReload()
	}

	/** 稳定的 fetch 入口（供 Node 适配器 / Vite dev server 使用） */
	get fetch() {
		return this.fetchPtr
	}

	/** 动态注入/撤销补丁（HMR 友好，合批重建） */
	modifyApp(mod: AppMod) {
		this.mods.add(mod)
		this.scheduleRebuild()

		return this.ctx.scope.collectEffect(() => {
			if (this.mods.delete(mod)) {
				this.scheduleRebuild()
			}
		})
	}

	activateAuthGuard() {
		if (this.guardEnabled) return
		this.guardEnabled = true
		this.scheduleRebuild()
		this.ctx.graphql?.scheduleRebuild()
	}

	isAuthGuardEnabled(): boolean {
		return this.guardEnabled
	}

	async evaluateAuthGuard(input: AuthGuardCheckInput): Promise<AuthGuardResult | undefined> {
		const service = this.resolveAuthGuard()
		if (!service) return undefined
		const result = await service.check(input)
		return result.allow ? undefined : result
	}

	// —— Vite Dev Server 插件（无 this.vite；仅在需要时标记 full-reload） ————
	get viteHonoDevServer(): Plugin {
		return devServer({
			exclude: [
				// 交给 Vite 模块系统处理的请求
				/^\/@.+$/, // /@vite, /@id, /@fs, /@react-refresh...
				/^\/node_modules\/.*/,
				/(\.ts|\.tsx)(\?.*)?$/,
				// 静态与杂项
				/^\/favicon\.ico$/,
				/^\/static\/.+/,
				/\?t=\d+$/,
			],
			loadModule: async () => ({ fetch: this.fetch }) as any,
			handleHotUpdate: ({ server }) => {
				if (this.shouldReload) {
					this.shouldReload = false
					server.ws.send({ type: 'full-reload' })
				}
				return []
			},
		})
	}

	// —— 内部：重建 / 指针更新 / 调度 ————————————————————————————————
	private rebuildApp(): HonoWithAppEnvType {
		const app = new Hono<AppEnv>({})

		// 注入 plugin_ctx（等价于 Factory.initApp 效果）
		app.use(async (c, next) => {
			c.set('plugin_ctx', this.ctx)
			await next()
		})


		// 1) 业务 API（仅对内置 /api 路由进行守卫包装，不影响 useModule/外部挂载的路由）
		this.mountInternalAPI(app)
		// 1.2) GraphQL —— 只挂一次路由，内部转发到函数指针
		app.all('/graphql', (c) => this.gqlFetch(c.req.raw, { hono: c }))

		// 2) 同步补丁（插件追加的路由/中间件）
		for (const m of this.mods) m(app as HonoWithAppEnvType)

		// 3.5) 内置路由守卫（仅对 HTML 请求生效）
		if (this.guardEnabled) {
			app.use('*', async (c, next) => {
				const denied = await this.guardRequest(
					c,
					'html',
					(result, meta) => this.respondGuardHtml(c, result, meta),
					(meta) => this.shouldGuardHtml(meta),
				)
				if (denied) return denied
				return next()
			})
		}

		// 4) SSR（仅在 Accept: text/html 时兜底，避免误伤 API）
		app.use('*', async (c, next) => {
			if (!this.isHtmlNavigation(c)) return next()
			return this.render(c)
		})

		// 切换活跃实例并更新 fetch 指针
		this.app = app as HonoWithAppEnvType
		this.updateFetchPtr()
		return this.app
	}

	/**
	 * 仅对内置 API（packages/hmr/src/api/hono）应用守卫，避免影响外部通过 modifyApp/useModule 注入的路由。
	 */
	private mountInternalAPI(app: HonoWithAppEnvType) {
		if (!this.guardEnabled) {
			app.route('/api', api as any)
			return
		}
		const guarded = new Hono<AppEnv>()
		guarded.use('*', async (c, next) => {
			const denied = await this.guardRequest(c, 'api', (result, meta) =>
				this.respondGuardJson(c, result, meta),
			)
			if (denied) return denied
			return next()
		})
		guarded.route('/', api as any)
		app.route('/api', guarded as any)
	}

	private async guardRequest(
		c: import('hono').Context<AppEnv>,
		source: GuardSource,
		onDenied: (
			result: AuthGuardResult,
			meta: GuardEvaluationContext,
		) => Response | Promise<Response>,
		shouldEvaluate?: (meta: GuardEvaluationContext) => boolean,
	): Promise<Response | undefined> {
		if (!this.guardEnabled) return undefined
		const meta = this.buildGuardContext(c, source)
		if (shouldEvaluate && !shouldEvaluate(meta)) return undefined

		const guardInput: AuthGuardCheckInput = {
			path: meta.path,
			method: meta.method,
			headers: meta.headers,
			request: meta.request,
			url: meta.url,
			context: meta.context,
		}

		const guardResult = await this.evaluateAuthGuard(guardInput)
		if (!guardResult) return undefined

		this.logGuardDenial(guardResult, meta)
		return onDenied(guardResult, meta)
	}

	private respondGuardJson(
		c: import('hono').Context<AppEnv>,
		result: AuthGuardResult,
		meta: GuardEvaluationContext,
	): Response {
		return c.json(
			{
				allow: false,
				code: 'access_denied',
				source: meta.source,
				path: meta.path,
				method: meta.method,
				pluginName: result.pluginName,
				reason: result.reason,
				redirectPath: result.redirectPath,
				context: meta.context ?? null,
			},
			403,
			{
				'Cache-Control': 'no-store',
			},
		)
	}

	private respondGuardHtml(
		c: import('hono').Context<AppEnv>,
		result: AuthGuardResult,
		meta: GuardEvaluationContext,
	): Response {
		const redirectTarget = result.redirectPath
		if (redirectTarget && redirectTarget !== meta.path) {
			return c.redirect(redirectTarget, 302)
		}
		return c.text('Access denied', 403, {
			'Cache-Control': 'no-store',
		})
	}

	private shouldGuardHtml(meta: GuardEvaluationContext): boolean {
		if (meta.method !== 'GET' && meta.method !== 'HEAD') return false
		const accept = meta.headers.get('accept')?.toLowerCase() ?? ''
		if (!accept.includes('text/html') && !accept.includes('*/*')) return false

		const fetchMode = meta.headers.get('sec-fetch-mode')
		if (fetchMode && fetchMode !== 'navigate') return false

		const fetchDest = meta.headers.get('sec-fetch-dest')
		if (fetchDest && fetchDest !== 'document' && fetchDest !== 'iframe') return false

		return true
	}

	private buildGuardContext(
		c: import('hono').Context<AppEnv>,
		source: GuardSource,
	): GuardEvaluationContext {
		const request = c.req.raw
		const headers =
			request.headers instanceof Headers ? request.headers : new Headers(request.headers)
		const url = this.tryParseUrl(request.url ?? c.req.url)
		const path = url?.pathname ?? c.req.path
		const method = (request.method ?? c.req.method).toUpperCase()
		const context: Readonly<Record<string, unknown>> =
			source === 'html'
				? Object.freeze({
						type: source,
						accept: headers.get('accept') ?? null,
						fetchMode: headers.get('sec-fetch-mode') ?? null,
						fetchDest: headers.get('sec-fetch-dest') ?? null,
					})
				: Object.freeze({ type: source })

		return {
			source,
			path,
			method,
			headers,
			request,
			url,
			context,
		}
	}

	private logGuardDenial(result: AuthGuardResult, meta: GuardEvaluationContext) {
		this.logger.warn('[AuthGuard] Blocked request', {
			source: meta.source,
			path: meta.path,
			method: meta.method,
			plugin: result.pluginName,
			reason: result.reason,
			redirect: result.redirectPath,
			context: meta.context ?? null,
		})
	}

	private isHtmlNavigation(c: import('hono').Context<AppEnv>): boolean {
		const meta = this.buildGuardContext(c, 'html')
		return this.shouldGuardHtml(meta)
	}

	private resolveAuthGuard(): AuthGuardService | undefined {
		if (!this.guardEnabled) return undefined
		if (this.authGuardRef) return this.authGuardRef
		try {
			const svc = this.ctx.authGuard
			this.authGuardRef = svc
			return svc
		} catch {
			return undefined
		}
	}

	/**
	 * Whether any auth guards are currently registered.
	 * Cheap check to allow upstream callers (e.g. GraphQL plugin) to skip
	 * heavy work like parsing operations when there's nothing to enforce.
	 */
	hasAuthGuards(): boolean {
		const svc = this.resolveAuthGuard()
		return !!svc && svc.hasGuards()
	}

	private tryParseUrl(input: string): URL | undefined {
		try {
			return new URL(input)
		} catch {
			return undefined
		}
	}

	private updateFetchPtr() {
		const f = this.app.fetch.bind(this.app)
		this.fetchPtr = (req, env, ctx) => f(req, env, ctx)
	}

	private scheduleRebuild() {
		if (this.pendingRebuild) return
		this.pendingRebuild = true
		queueMicrotask(() => {
			this.pendingRebuild = false
			this.rebuildApp()
			this.requestFullReload()
		})
	}

	private requestFullReload() {
		// 不直接操作 Vite Server；仅做标记，交由其他服务/插件感知并触发
		this.shouldReload = true
	}

	private createRenderer(): Promise<RenderHandler> {
		if (import.meta.env.PLUXEL_HMR_SSR) {
			return import('../../server/dev').then(({ createDevRenderer }) => createDevRenderer())
		} // 默认使用静态渲染，避免构建产物引入 SSR 依赖
		return import('../../server/static').then(({ createStaticRenderer }) => createStaticRenderer())
	}

	private async render(c: import('hono').Context<AppEnv>) {
		const handler = await this.renderer
		return handler(c)
	}
}
