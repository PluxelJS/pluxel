import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { Hono } from 'hono'
import { createFactory, type Factory } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Plugin } from 'vite'

import api from '../../api/hono'
import type { RenderHandler } from '../../server/types'
import type { AuthGuardCheckInput } from './AuthGuardService'
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

@Injectable({ key: serviceName })
export class HonoService {
	private mods = new Set<AppMod>()

	// 活跃 Hono 实例
	private app!: HonoWithAppEnvType

	// 稳定 fetch 指针：只替换目标，不换引用
	private fetchPtr: (req: Request, env?: any, ctx?: any) => Response | Promise<Response> = (
		req,
		env,
		ctx,
	) => this.app.fetch(req, env, ctx)

	// 合批重建/全量刷新
	private pendingRebuild = false
	private shouldReload = false

	// GraphQL：函数指针替换 → 零重建
	private gqlFetch: GraphQLFetch = async () => new Response('GraphQL not ready', { status: 503 })

	// 是否需要对内部 /api/* 套 Guard
	private guardRegistered = false

	private readonly logger: NonNullable<Context['logger']>
	private readonly renderer: Promise<RenderHandler>

	constructor(private ctx: Context) {
		this.logger = ctx.logger!
		this.renderer = this.createRenderer()
		this.rebuildApp()

		// GraphQL 初次装配在其它服务就绪后由其通知；这里只是确保会触发一次重织
		ctx.graphql.scheduleRebuild()
	}

	/** 将 plugin_ctx 暴露给下游（Hono 工厂） */
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

	/** GraphQLService 重织：仅替换函数指针 */
	setGraphQLFetch(fn: GraphQLFetch) {
		this.gqlFetch = fn
		this.requestFullReload()
	}

	/** 稳定 fetch 入口（供适配器/Vite Dev Server 用） */
	get fetch() {
		return this.fetchPtr
	}

	/** 插件注入/撤销 Hono 补丁（自动合批重建） */
	modifyApp(mod: AppMod) {
		this.mods.add(mod)
		this.scheduleRebuild()
		return this.ctx.scope.collectEffect(() => {
			if (this.mods.delete(mod)) this.scheduleRebuild()
		})
	}

	/** AuthGuardService 通知：是否启用 /api/* 守卫 */
	switchAuthGuard(toggle: boolean) {
		if (this.guardRegistered === toggle) return
		this.guardRegistered = toggle
		this.scheduleRebuild()
	}

	// —— Vite Dev Server 插件：仅负责 full-reload 信号 —— //
	get viteHonoDevServer(): Plugin {
		return devServer({
			exclude: [
				/^\/@.+$/,
				/^\/node_modules\/.*/,
				/(\.ts|\.tsx)(\?.*)?$/,
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

	// —— 内部：实例重建与装配 —— //

	private rebuildApp(): HonoWithAppEnvType {
		const app = new Hono<AppEnv>({})

		// 注入 plugin_ctx
		app.use(async (c, next) => {
			c.set('plugin_ctx', this.ctx)
			await next()
		})

		// 1) 内部 API：可选守卫，仅作用于 /api/*，不影响外部注入
		this.mountInternalAPI(app as HonoWithAppEnvType)

		// 2) GraphQL：只挂一次路由，内部转发到函数指针
		app.all('/graphql', (c) => this.gqlFetch(c.req.raw, { hono: c }))

		// 3) 插件追加的外部路由/中间件（不被守卫包裹）
		for (const m of this.mods) m(app as HonoWithAppEnvType)

		// 4) SSR 兜底（仅 HTML 导航）
		app.use('*', async (c, next) => {
			if (!this.isHtmlNavigation(c)) return next()
			return this.render(c)
		})

		// 原子切换活跃实例 + 更新 fetch 指针目标
		this.app = app as HonoWithAppEnvType
		this.updateFetchPtr()

		return this.app
	}

	/** 仅对“内部 API”应用守卫 */
	private mountInternalAPI(app: HonoWithAppEnvType) {
		if (!this.guardRegistered) {
			app.route('/api', api)
			return
		}

		const guarded = new Hono<AppEnv>()
		guarded.use('*', async (c, next) => {
			const denied = await this.guardApiRequest(c)
			if (denied) return denied
			return next()
		})
		guarded.route('/', api)

		app.route('/api', guarded as any)
	}

	private async guardApiRequest(c: import('hono').Context<AppEnv>): Promise<Response | undefined> {
		const service = this.ctx.authGuard
		if (!service || !service.isActive()) return undefined

		const request = c.req.raw
		const headers =
			request.headers instanceof Headers ? request.headers : new Headers(request.headers)
		const url = c.req.url
		const path = c.req.path
		const method = (request.method ?? c.req.method).toUpperCase()

		const guardInput: AuthGuardCheckInput = {
			path,
			method,
			headers,
			request,
			url,
		}

		const result = await service.check(guardInput)
		if (result.allow) return undefined

		const status: ContentfulStatusCode = result.status ?? 403

		// 避免把重对象打进日志
		this.logger.warn('[AuthGuard] Blocked request', {
			path,
			method,
			plugin: result.pluginName,
			reason: result.reason,
			redirect: result.redirectPath,
			status,
		})

		return c.json(
			{
				allow: false,
				code: 'access_denied',
				path,
				method,
				pluginName: result.pluginName,
				reason: result.reason,
				redirectPath: result.redirectPath,
			},
			status,
			{
				'Cache-Control': 'no-store',
				// 客户端可据此快速判断“需要处理重定向”
				'X-Pluxel-Auth-Blocked': '1',
			},
		)
	}

	private isHtmlNavigation(c: import('hono').Context<AppEnv>): boolean {
		const req = c.req.raw
		const headers = req.headers instanceof Headers ? req.headers : new Headers(req.headers)
		const method = (req.method ?? c.req.method).toUpperCase()
		if (method !== 'GET' && method !== 'HEAD') return false

		const accept = (headers.get('accept') ?? '').toLowerCase()
		if (!accept.includes('text/html') && !accept.includes('*/*')) return false

		const fetchMode = headers.get('sec-fetch-mode')
		if (fetchMode && fetchMode !== 'navigate') return false

		const fetchDest = headers.get('sec-fetch-dest')
		if (fetchDest && fetchDest !== 'document' && fetchDest !== 'iframe') return false

		return true
	}

	private updateFetchPtr() {
		const f = this.app.fetch.bind(this.app)
		this.fetchPtr = (req, env, ctx) => f(req, env, ctx)
	}

	/** 合批重建，避免抖动 */
	private scheduleRebuild() {
		if (this.pendingRebuild) return
		this.pendingRebuild = true
		queueMicrotask(() => {
			this.pendingRebuild = false
			this.rebuildApp()
			this.requestFullReload()
		})
	}

	/** 仅做标记，由 Vite 插件感知并下发 full-reload */
	private requestFullReload() {
		this.shouldReload = true
	}

	private createRenderer(): Promise<RenderHandler> {
		const isProd = process.env.NODE_ENV === 'production'

		// #if NODE_ENV !== 'production'
		if (!isProd) {
			const importMetaEnv = (import.meta as ImportMeta & { env?: Record<string, any> }).env
			const ssrFlag =
				importMetaEnv?.PLUXEL_HMR_SSR ??
				(typeof process !== 'undefined' && process.env ? process.env.PLUXEL_HMR_SSR : undefined)

			if (ssrFlag) {
				return import('../../server/dev').then(({ createDevRenderer }) => createDevRenderer())
			}
		}
		// #endif

		return import('../../server/static').then(({ createStaticRenderer }) => createStaticRenderer())
	}

	private async render(c: import('hono').Context<AppEnv>) {
		const handler = await this.renderer
		return handler(c)
	}
}
