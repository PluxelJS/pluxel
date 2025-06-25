import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { Hono } from 'hono'

declare module '@pluxel/core' {
	interface Context {
		honoService: HonoService
	}
}

@Injectable
export class HonoService {
	static key = 'honoService'
	// 1. 先初始化 mods
	private mods: Array<(app: Hono) => void> = []
	// 2. 再调用 createApp（此时 mods 已经是 [] 了）
	private app = this.createApp()
	shouldReload = false

	constructor(private ctx: Context) {}
	private createApp() {
		// 1) 每次都用 LinearRouter
		const a = new Hono()
		// 2) 先注册核心路由
		a.get('/', (c) => c.text('Hello Honoaa!'))

		// 3) 再把所有外部补丁打上去
		for (const m of this.mods) {
			m(a)
		}

		return a
	}

	get fetch() {
		return this.app.fetch
	}

	modifyApp(mod: (app: Hono) => void) {
		this.mods.push(mod) // 保存“补丁”
		this.app = this.createApp() // 重建实例，连 core + mods 都跑一遍
		this.shouldReload = true
		return this.ctx.collect(() => {
			console.log('移除路由')
			// 从 this.mods 中移除当前 mod
			const idx = this.mods.indexOf(mod)
			if (idx !== -1) this.mods.splice(idx, 1)
			// 再次重建实例，移除该补丁
			this.app = this.createApp()
			this.shouldReload = true
		})
	}

	get vitePlugin() {
		return devServer({
			loadModule: async (server) =>
				({
					fetch: this.fetch,
				}) as any,
			handleHotUpdate: ({ server }) => {
				console.log('触发honohmr')
				if (this.shouldReload) {
					console.log('应该重载')
					this.shouldReload = false
					server.hot.send({ type: 'full-reload' })
					server.ws.send({ type: 'full-reload' })
				}
				return []
			},
		})
	}
}
