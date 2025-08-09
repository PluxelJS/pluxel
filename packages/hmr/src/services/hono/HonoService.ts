import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { createFactory, type Factory } from 'hono/factory'
import api from '../../app/api'
import loggerApi from '../logger/api'
import { ssrApp } from '../../server'
import type { AppEnv, HonoType } from './env'
import type { Plugin } from 'vite'

declare module '@pluxel/core' {
	interface Context {
		honoService: HonoService
	}
}

@Injectable
export class HonoService {
	static key = 'honoService'
	// 1. 先初始化 mods
	private mods: Array<(app: HonoType) => void> = []
	// 2. 再调用 createApp（此时 mods 已经是 [] 了）
	private app = this.applyApp()
	shouldReload = false

	constructor(private ctx: Context) {}
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

	private applyApp() {
		const a = this.createFactory().createApp()
		a.route('/api', api)
		a.route('/', loggerApi)
		for (const m of this.mods) {
			m(a)
		}
		// 把 ssr 路由放最后避免覆盖
		a.route('/', ssrApp)
		return a
	}

	get fetch() {
		return this.app.fetch
	}

	modifyApp(mod: (app: HonoType) => void) {
		this.mods.push(mod) // 保存“补丁”
		this.app = this.applyApp()
		this.shouldReload = true
		return this.ctx.collect(() => {
			// 从 this.mods 中移除当前 mod
			const idx = this.mods.indexOf(mod)
			if (idx !== -1) this.mods.splice(idx, 1)
			// 再次重建实例，移除该补丁
			this.app = this.applyApp()
			this.shouldReload = true
		})
	}

	get viteHonoDevServer(): Plugin {
		return devServer({
			loadModule: async (server) =>
				({
					fetch: this.fetch,
				}) as any,
			handleHotUpdate: ({ server }) => {
				this.ctx.logger.debug('触发 hmr')
				// 开启才能客户端动态刷新，但每次请求都会触发导致刷新。
				/* server.hot.send({ type: 'full-reload' })
				server.ws.send({ type: 'full-reload' }) */
				if (this.shouldReload) {
					this.ctx.logger.debug('触发全量重载')
					this.shouldReload = false
					server.hot.send({ type: 'full-reload' })
					server.ws.send({ type: 'full-reload' })
				}
				return []
			},
		})
	}
}
