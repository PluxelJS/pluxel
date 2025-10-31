// src/services/hono/HonoService.ts

import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { Hono } from 'hono'
import { createFactory, type Factory } from 'hono/factory'
import type { Plugin } from 'vite'

import api from '../../api/hono'
import type { RenderHandler } from '../../server/types'
import loggerApi from '../logger/api'
import type {
	AuthGuardCheckInput,
	AuthGuardResult,
	AuthGuardService,
} from '../auth/AuthGuardService'
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

const parseBooleanFlag = (value?: string | null): boolean | undefined => {
	if (value == null) return undefined
	switch (value.toLowerCase()) {
		case '1':
		case 'true':
		case 'yes':
		case 'on':
			return true
		case '0':
		case 'false':
		case 'no':
		case 'off':
			return false
		default:
			return undefined
	}
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

	constructor(private ctx: Context) {
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

		// 1) 业务 API（必要时包裹内置路由）
		app.route('/api', this.guardEnabled ? this.createGuardedApiRouter(api) : api)

		// 1.2) GraphQL —— 只挂一次路由，内部转发到函数指针
		app.all('/graphql', (c) => this.gqlFetch(c.req.raw, { hono: c }))

		// 2) 同步补丁（插件追加的路由/中间件）
		for (const m of this.mods) m(app as HonoWithAppEnvType)

		// 3) logger
		app.route('/', loggerApi)

		// 3.5) 内置路由守卫（仅对 HTML 请求生效）
		if (this.guardEnabled) {
			app.use('*', async (c, next) => {
				if (c.req.method !== 'GET') return next()
				const accept = c.req.header('accept') || ''
				if (!accept.includes('text/html')) return next()

				const denied = await this.guardRequest(c, (result, { path }) => {
					const redirectTarget = result.redirectPath
					if (redirectTarget) {
						if (redirectTarget === path) {
							return c.text('Access denied', 403)
						}
						return c.redirect(redirectTarget, 302)
					}
					return c.text('Access denied', 403)
				})
				if (denied) return denied
				return next()
			})
		}

		// 4) SSR（仅在 Accept: text/html 时兜底，避免误伤 API）
		app.use('*', async (c, next) => {
			if (c.req.method !== 'GET') return next()
			const accept = c.req.header('accept') || ''
			if (!accept.includes('text/html')) return next()
			return this.render(c)
		})

		// 切换活跃实例并更新 fetch 指针
		this.app = app as HonoWithAppEnvType
		this.updateFetchPtr()
		return this.app
	}

	private async guardRequest(
		c: import('hono').Context<AppEnv>,
		onDenied: (result: AuthGuardResult, meta: { path: string }) => Response | Promise<Response>,
	): Promise<Response | undefined> {
		if (!this.guardEnabled) return undefined
		const requestUrl = this.tryParseUrl(c.req.url)
		const path = requestUrl?.pathname ?? c.req.path
		const guardResult = await this.evaluateAuthGuard({
			path,
			method: c.req.method,
			headers: c.req.raw.headers,
			request: c.req.raw,
			url: requestUrl,
		})

		if (!guardResult) return undefined
		return onDenied(guardResult, { path })
	}

	private respondGuardJson(
		c: import('hono').Context<AppEnv>,
		result: AuthGuardResult,
	): Response {
		return c.json(
			{
				allow: false,
				code: 'access_denied',
				pluginName: result.pluginName,
				reason: result.reason,
				redirectPath: result.redirectPath,
			},
			403,
		)
	}

	private createGuardedApiRouter(base: Hono<AppEnv>): Hono<AppEnv> {
		const guarded = new Hono<AppEnv>()
		guarded.use('*', async (c, next) => {
			const denied = await this.guardRequest(c, (result) => this.respondGuardJson(c, result))
			if (denied) return denied
			await next()
		})
		guarded.route('/', base)
		return guarded
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
		const flag = parseBooleanFlag(process.env.PLUXEL_HMR_SSR)
		if (flag === true) {
			return import('../../server/dev').then(({ createDevRenderer }) => createDevRenderer())
		}
		if (flag === false) {
			return import('../../server/static').then(({ createStaticRenderer }) => createStaticRenderer())
		}
		// 默认使用静态渲染，避免构建产物引入 SSR 依赖
		return import('../../server/static').then(({ createStaticRenderer }) => createStaticRenderer())
	}

	private async render(c: import('hono').Context<AppEnv>) {
		const handler = await this.renderer
		return handler(c)
	}
}
