import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pluginsApp } from './plugins'

const app = new Hono<AppEnv>()
	.get('/', (c) => {
		return c.text('Hello Hono!')
	})
	.get('/plugins', (c) => {
		const ctx = c.var.plugin_ctx
		return c.json(ctx.loader.getLoadedPluginsName())
	})
	.route('/', pluginsApp)

export default app

export type AppType = typeof app
