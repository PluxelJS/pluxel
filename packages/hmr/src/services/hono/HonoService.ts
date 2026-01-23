import devServer from '@hono/vite-dev-server'
import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import {
	type AppMod,
	HonoService as CoreHonoService,
	type GraphQLFetch,
} from '@pluxel/core/services'
import { Hono } from 'hono'
import { createFactory, type Factory } from 'hono/factory'
import type { Plugin } from 'vite'

import api from '../../api/hono'
import type { RenderHandler } from '../../server/types'
import type { SseChannel } from '../plugin-interaction'
import type { ExtensionManifestEvent } from '../runtime-compile'
import type { AuthGuardContext, AuthGuardKind, AuthGuardResult } from './AuthGuardService'
import type { AppEnv, HonoWithAppEnvType } from './env'

@Injectable
@OverrideOf(CoreHonoService)
export class HonoService extends CoreHonoService {
	// 活跃 Hono 实例
	private app!: HonoWithAppEnvType

	// 合批重建/全量刷新
	private shouldReload = false

	private readonly logger: NonNullable<Context['logger']>
	private readonly renderer: Promise<RenderHandler>
	private sseBuiltinsReady = false

	constructor(ctx: Context) {
		super(ctx)
		this.logger = ctx.logger!
		this.renderer = this.createRenderer()
		this.rebuildApp()
		this.registerSseBuiltins()

		// GraphQL 初次装配在其它服务就绪后由其通知；这里只是确保会触发一次重织
		ctx.graphql.scheduleRebuild()
	}

	/** 将 plugin_ctx 暴露给下游（Hono 工厂） */
	public override createFactory(): Factory<AppEnv, string> {
		return createFactory<AppEnv>({
			initApp: (app) => this.attachPluginContext(app),
		})
	}

	override modifyApp<App = HonoWithAppEnvType>(mod: AppMod<App>): () => void {
		return super.modifyApp(mod)
	}

	/** GraphQLService 重织：仅替换函数指针 */
	override setGraphQLFetch(fn: GraphQLFetch) {
		this.gqlFetch = fn
		this.requestFullReload()
	}

	/** AuthGuardService 通知：是否启用 /api/* 守卫 */
	override switchAuthGuard(toggle: boolean) {
		// 旧接口保留：当前实现按请求动态读取 AuthGuardService 状态，不需要重建 app。
		void toggle
	}

	// —— Vite Dev Server 插件：仅负责 full-reload 信号 —— //
	override get viteHonoDevServer(): Plugin {
		return devServer({
			exclude: [
				/^\/@.+$/,
				/^\/node_modules\/.*/,
				/(\.ts|\.tsx)(\?.*)?$/,
				/^\/favicon\.ico$/,
				/^\/static\/.+/,
				/\?t=\d+$/,
			],
			// biome-ignore lint/suspicious/noExplicitAny: @hono/vite-dev-server expects a module-like object shape.
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
		this.attachPluginContext(app)

		// 1) 内部 API：可选守卫，仅作用于 /api/*，不影响外部注入
		this.mountInternalAPI(app as HonoWithAppEnvType)

		// 2) GraphQL：只挂一次路由，内部转发到函数指针
		app.all('/graphql', async (c) => {
			const denied = await this.guardInternalRequest(c, 'graphql')
			if (denied) return denied
			return this.gqlFetch(c.req.raw, { hono: c })
		})

		// 3) 插件追加的外部路由/中间件（不被守卫包裹）
		for (const m of this.mods) m(app as HonoWithAppEnvType)

		// 4) SPA 兜底（仅 HTML 导航）
		app.use('*', async (c, next) => {
			if (!this.isHtmlNavigation(c)) return next()
			const denied = await this.guardInternalRequest(c, 'ui')
			if (denied) return denied
			return this.render(c)
		})

		// 原子切换活跃实例 + 更新 fetch 指针目标
		this.app = app as HonoWithAppEnvType
		this.updateFetchPtr()

		return this.app
	}

	private registerSseBuiltins() {
		if (this.sseBuiltinsReady) return
		this.sseBuiltinsReady = true

		const disposers = [
			this.registerBuiltinSse('extensions', (channel) => this.streamManifestEvents(channel)),
		]

		for (const dispose of disposers) this.ctx.scope.collectEffect(dispose)
	}

	private registerBuiltinSse(
		namespace: string,
		handler: (channel: SseChannel) => undefined | (() => void),
	) {
		return this.ctx.ext.sse.registerExtension(() => handler, { namespace })
	}

	private streamManifestEvents(channel: SseChannel) {
		const service = this.ctx.ext.ui
		if (!service) {
			channel.emit('error', { reason: 'Extension service unavailable' })
			return
		}

		channel.emit('ready', { type: 'ready' })
		// 先推一次版本；客户端收到 sync 后按需拉取 manifest
		channel.emit('sync', { type: 'sync', version: service.getManifest().version })

		const send = (event: ExtensionManifestEvent) => channel.emit(event.type, event)
		const unsubscribe = service.subscribeManifest(send)
		channel.onAbort(unsubscribe)
		return () => unsubscribe()
	}

	/** 仅对“内部 API”应用守卫 */
	private mountInternalAPI(app: HonoWithAppEnvType) {
		app.use('/api', async (c, next) => {
			const denied = await this.guardInternalRequest(c, 'api')
			if (denied) return denied
			return next()
		})
		app.use('/api/*', async (c, next) => {
			const denied = await this.guardInternalRequest(c, 'api')
			if (denied) return denied
			return next()
		})
		app.route('/api', api)
	}

	private async guardInternalRequest(
		c: import('hono').Context<AppEnv>,
		kind: AuthGuardKind,
	): Promise<Response | undefined> {
		const service = this.ctx.authGuard
		if (!service || !service.isActive()) return undefined

		const request = c.req.raw
		const headers =
			request.headers instanceof Headers ? request.headers : new Headers(request.headers)
		const url = c.req.url
		const path = c.req.path
		const method = (request.method ?? c.req.method).toUpperCase()

		// 认证元信息必须可达：用于前端在不打全局补丁的前提下获取登录入口 redirectPath 等信息。
		if (kind === 'api' && path === '/api/auth/meta') return undefined

		const input: AuthGuardContext = {
			kind,
			path,
			method,
			headers,
			request,
			url,
		}

		const result = await service.check(input)
		if (result.allow) return undefined

		this.logger.warn('Blocked request', { kind, path, method, pluginName: result.pluginName })

		return this.buildAuthDeniedResponse(c, kind, result)
	}

	private buildAuthDeniedResponse(
		c: import('hono').Context<AppEnv>,
		kind: AuthGuardKind,
		result: Extract<AuthGuardResult, { allow: false }>,
	): Response {
		if (kind === 'ui') {
			return c.redirect(result.redirectPath, 302)
		}

		return c.json(
			{
				allow: false,
				code: 'access_denied',
				kind,
				path: c.req.path,
				method: c.req.method,
				pluginName: result.pluginName,
				redirectPath: result.redirectPath,
			},
			401,
			{
				'Cache-Control': 'no-store',
				'X-Pluxel-Auth-Blocked': '1',
				'X-Pluxel-Redirect-Path': result.redirectPath,
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
	protected override rebuildNow() {
		this.rebuildApp()
		this.requestFullReload()
	}

	/** 仅做标记，由 Vite 插件感知并下发 full-reload */
	private requestFullReload() {
		this.shouldReload = true
	}

	private createRenderer(): Promise<RenderHandler> {
		// NOTE: `#if SOURCE_ONLY`/`#endif` blocks are stripped by tsdown for non-source builds.
		// Do NOT remove them or rewrite this into runtime conditions.
		// #if SOURCE_ONLY
		return import('../../server/dev').then(({ createDevRenderer }) => createDevRenderer())
		// #endif

		// biome-ignore lint/correctness/noUnreachable: tsdown strips SOURCE_ONLY blocks in non-source builds.
		return import('../../server/static').then(({ createStaticRenderer }) => createStaticRenderer())
	}

	private async render(c: import('hono').Context<AppEnv>) {
		const handler = await this.renderer
		return handler(c)
	}

	private attachPluginContext(app: Pick<Hono<AppEnv>, 'use'>) {
		app.use(async (c, next) => {
			c.set('plugin_ctx', this.ctx)
			await next()
		})
	}
}
