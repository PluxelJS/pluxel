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
	private app = new Hono()
	shouldReload = false

	get fetch() {
		return this.app.fetch
	}

	get vitePlugin() {
		return devServer({
			loadModule: async (server) => {
				return { fetch: this.fetch } as any
			},
			handleHotUpdate: ({ file, server }) => {
				if (this.shouldReload) server.hot.send({ type: 'full-reload' })
				return []
			},
		})
	}
	constructor(private ctx: Context) {}
}
