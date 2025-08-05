import { Hono } from 'hono'
import type { AppEnv } from '../../../services/hono/env'
import * as v from 'valibot'
import { vValidator } from '@hono/valibot-validator'

const updateStatusSchema = v.object({
	pluginName: v.string(),
	status: v.picklist(['start', 'stop', 'restart']),
})
type UpdateStatusPayload = v.InferOutput<typeof updateStatusSchema>

export const updateStatus = new Hono<AppEnv>().patch(
	'/',
	vValidator('json', updateStatusSchema),
	(c) => {
		const inputData: UpdateStatusPayload = c.req.valid('json')
		const pluginName = inputData.pluginName

		const ctx = c.var.plugin_ctx
		const ctor = ctx.loader.getPluginClassByName(pluginName)

		if (!ctor) {
			return c.json(
				{ code: 'plugin_not_found', error: 'Plugin not found' },
				404,
			)
		}

		const loaderRegisry = ctx.loader.registry
		if (inputData.status === 'start') {
			loaderRegisry.enablePlugin(pluginName, ctor)
		} else if (inputData.status === 'stop') {
			loaderRegisry.disablePlugin(pluginName, ctor)
		}

		ctx.registry.commit()
		return c.json({}, 200)
	},
)
