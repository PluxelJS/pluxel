import devServer from '@hono/vite-dev-server'
import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import {
	type AppMod,
	HonoService as CoreHonoService,
	type GraphQLFetch,
} from '@pluxel/core/services'
import { Hono } from 'hono'
import { createFactory, type Factory } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Plugin } from 'vite'

import api from '../../api/hono'
import type { RenderHandler } from '../../server/types'
import { logStore, matchesFilter } from '../logger/logStore'
import type { SseChannel } from '../plugin-interaction'
import type { ExtensionManifestEvent } from '../runtime-compile'
import type { AuthGuardCheckInput } from './AuthGuardService'
import type { AppEnv, HonoWithAppEnvType } from './env'

@Injectable
@OverrideOf(CoreHonoService)
export class HonoService extends CoreHonoService {
	// 活跃 Hono 实例
	private app!: HonoWithAppEnvType

	// 合批重建/全量刷新
	private shouldReload = false

	// 是否需要对内部 /api/* 套 Guard
	private guardRegistered = false

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
		if (this.guardRegistered === toggle) return
		this.guardRegistered = toggle
		this.scheduleRebuild()
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

	private registerSseBuiltins() {
		if (this.sseBuiltinsReady) return
		this.sseBuiltinsReady = true

		const disposers = [
			this.registerBuiltinSse('extensions', (channel) => this.streamManifestEvents(channel)),
			this.registerBuiltinSse('logs', (channel) => this.streamLogs(channel)),
		]

		for (const dispose of disposers) this.ctx.scope.collectEffect(dispose)
	}

	private registerBuiltinSse(
		namespace: string,
		handler: (channel: SseChannel) => void | (() => void),
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

	private streamLogs(channel: SseChannel) {
		const filter = channel.query.get('name') ?? ''

		channel.emit('ready', { type: 'ready', name: filter })
		const send = (log: unknown) => channel.emit('log', log)

		logStore
			.snapshot()
			.filter((l) => matchesFilter(l, filter))
			.forEach(send)

		const unsubscribe = logStore.subscribe((l) => {
			if (matchesFilter(l, filter)) send(l)
		})
		channel.onAbort(unsubscribe)
		return () => unsubscribe()
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
	protected override rebuildNow() {
		this.rebuildApp()
		this.requestFullReload()
	}

	/** 仅做标记，由 Vite 插件感知并下发 full-reload */
	private requestFullReload() {
		this.shouldReload = true
	}

	private createRenderer(): Promise<RenderHandler> {
		// #if SOURCE_ONLY
		const importMetaEnv = (import.meta as ImportMeta & { env?: Record<string, any> }).env

		const ssrFlag =
			importMetaEnv?.PLUXEL_HMR_SSR ??
			(typeof process !== 'undefined' && process.env ? process.env.PLUXEL_HMR_SSR : undefined)

		if (ssrFlag) {
			return import('../../server/dev').then(({ createDevRenderer }) => createDevRenderer())
		}
		// #endif

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
