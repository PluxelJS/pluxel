import type { PluginConstructor } from '@pluxel/core'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AddVars, AppEnv } from '../env'
import { pluginConfig } from './config'
import { groupsList } from './groupsList'
import { pluginStatus } from './status'

export type PluginsEnv = AddVars<AppEnv, { pluginName: string; pluginCtor: PluginConstructor }>
export const withPluginMiddleware = createMiddleware<PluginsEnv>(async (c, next) => {
	const name = c.req.param('name')
	if (!name) {
		return c.json({ code: 'plugin_not_found', error: 'Name must be provided' }, 403)
	}
	const ctor = c.var.plugin_ctx.loader.getPluginClassByName(name)
	if (!ctor) {
		return c.json({ code: 'plugin_not_found', error: 'Plugin not found' }, 404)
	}
	c.set('pluginName', name)
	c.set('pluginCtor', ctor)
	await next()
})

export const byNameApp = new Hono<PluginsEnv>()
	.use('/:name/*', withPluginMiddleware)
	.get('/:name', (c) => {
		const { plugin_ctx: ctx, pluginCtor: ctor, pluginName } = c.var

		if (!ctor) {
			return c.json({ code: 'plugin_not_found', error: 'Plugin not found' }, 404)
		}

		return c.json(
			{
				name: pluginName,
				desc: '插件示例描述',
				dependencies: ctx.loader.getPluginDependenciesInfo(ctor),
			},
			200,
		)
	})
	.route('/:name/config', pluginConfig)
	.route('/:name/status', pluginStatus)

export default new Hono<AppEnv>()
	.get('/', (c) => {
		const ctx = c.var.plugin_ctx
		return c.json(ctx.loader.getFullPluginStatus())
	})
	.route('/groups', groupsList)
	.route('/', byNameApp)
