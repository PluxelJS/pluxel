// src/services/hono/HonoService.ts

import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { Hono } from 'hono'
import { createFactory, type Factory } from 'hono/factory'

import api from '../../app/api'
import { ssrApp } from '../../server'
import loggerApi from '../logger/api'
import type { AppEnv, HonoWithAppEnvType } from './env'
import type { GraphQLService } from './GraphQLService'

const serviceName = 'honoService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HonoService
		graphqlService: GraphQLService
	}
}

type AppMod = (app: HonoWithAppEnvType) => void
type GraphQLFetch = (
	req: Request,
	ctx: { hono: import('hono').Context<AppEnv> },
) => Promise<Response>

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

	constructor(private ctx: Context) {
		this.rebuildApp()
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

	// —— Vite Dev Server 插件（无 this.vite；仅在需要时标记 full-reload） ————
	get viteHonoDevServer() {
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

		// 1) 业务 API
		app.route('/api', api)

		// 1.5) GraphQL —— 只挂一次路由，内部转发到函数指针
		app.all('/graphql', (c) => this.gqlFetch(c.req.raw, { hono: c }))

		// 2) 同步补丁（插件追加的路由/中间件）
		for (const m of this.mods) m(app as HonoWithAppEnvType)

		// 3) logger
		app.route('/', loggerApi)

		// 4) SSR（仅在 Accept: text/html 时兜底，避免误伤 API）
		app.use('*', async (c, next) => {
			if (c.req.method !== 'GET') return next()
			const accept = c.req.header('accept') || ''
			if (!accept.includes('text/html')) return next()
			return ssrApp.fetch(c.req.raw, c.env, c.executionCtx)
		})

		// 切换活跃实例并更新 fetch 指针
		this.app = app as HonoWithAppEnvType
		this.updateFetchPtr()
		return this.app
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
}
