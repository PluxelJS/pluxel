import { Hono } from 'hono'
import type { AppEnv } from '../../../services/hono/env'
import { pluginsPostConfig } from './postConfig'
import { updateStatus } from './updateStatus'
import { groupsList } from './groupsList'

export default new Hono<AppEnv>()
	.route('/', updateStatus)
	.route('/', groupsList)
	// 带 : 的路由一定放最后，要不然在验证时会覆盖。
	.route('/', pluginsPostConfig)
	.get('/', (c) => {
		const ctx = c.var.plugin_ctx
		return c.json(ctx.loader.getFullPluginStatus())
	})
	.get('/:name', (c) => {
		const pluginName = c.req.param('name')
		const ctx = c.var.plugin_ctx
		const ctor = ctx.loader.getPluginClassByName(pluginName)

		if (!ctor) {
			return c.json(
				{ code: 'plugin_not_found', error: 'Plugin not found' },
				404,
			)
		}

		return c.json(
			{
				name: pluginName,
				desc: '插件示例描述',
				isRunning: ctx.registry.isRunning(ctor),
				config: ctx.loader.getPluginSchema(ctor),
				existConfig: ctx.configService.getConfig(pluginName).configRecord,
				dependencies: ctx.loader.getPluginDependenciesInfo(ctor),
			},
			200,
		)
	})
