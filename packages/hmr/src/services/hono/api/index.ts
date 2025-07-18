import { Hono } from 'hono'
import type { Env } from '../env'

const app = new Hono<Env>()
	.get('/', (c) => {
		return c.text('Hello Hono!')
	})
	.get('/plugins', (c) => {
		const ctx = c.var.plugin_ctx
		return c.json(ctx.loader.getLoadedPluginsName())
	})
	.get('/plugins/:name', (c) => {
		const ctx = c.var.plugin_ctx
		const pluginName = c.req.param('name')
		const ctor = ctx.loader.nameMap.get(pluginName)
		if (!ctor) {
			return c.json({ error: 'Plugin not found' }, 404)
		}
		return c.json({
			name: pluginName,
			desc: '插件示例描述',
			config: ctx.loader.getPluginConfig(ctor),
		})
	})

export default app

export type AppType = typeof app
