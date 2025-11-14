import { vValidator } from '@hono/valibot-validator'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { PluginsEnv } from '.'

// 校验 Schema
const updateStatusSchema = v.object({
	status: v.picklist(['start', 'stop', 'restart', 'enable', 'disable']),
})
type UpdateStatusPayload = v.InferOutput<typeof updateStatusSchema>

const lifecycleStage = (isRunning: boolean, isEnabled: boolean) => {
	if (!isEnabled) return 'disabled' as const
	return isRunning ? ('running' as const) : ('stopped' as const)
}

export const pluginStatus = new Hono<PluginsEnv>()
	.get('/', (c) => {
		const { plugin_ctx: ctx, pluginCtor: ctor, pluginName } = c.var
		const isRunning = ctx.loader.isRunning(ctor)
		const isEnabled = ctx.configService.isEnable(pluginName)
		return c.json({
			code: 'success',
			isRunning,
			isEnabled,
			lifecycleStage: lifecycleStage(isRunning, isEnabled),
		})
	})
	.post('/', vValidator('json', updateStatusSchema), async (c) => {
		const { status } = c.req.valid('json') as UpdateStatusPayload
		const { plugin_ctx: ctx, pluginCtor: ctor, pluginName } = c.var

		const registry = ctx.loader.registry
		const snapshot = () => {
			const isRunning = ctx.loader.isRunning(ctor)
			const isEnabled = ctx.configService.isEnable(pluginName)
			return {
				isRunning,
				isEnabled,
				lifecycleStage: lifecycleStage(isRunning, isEnabled),
			}
		}

		try {
			switch (status) {
				case 'start':
					registry.enable(pluginName, ctor)
					break
				case 'stop':
					registry.deactivate(pluginName, ctor, { runtimeOnly: true })
					break
				case 'restart':
					registry.deactivate(pluginName, ctor, { runtimeOnly: true })
					registry.enable(pluginName, ctor)
					break
				case 'disable':
					registry.deactivate(pluginName, ctor, { runtimeOnly: false })
					break
				case 'enable':
					registry.enablePersisted(pluginName)
					break
				default:
					return c.json({ code: 'invalid_status', error: `不支持的状态：${status}` }, 400)
			}
			// 一次性提交所有变更
			const result = await ctx.registry.commit()
			if (result.err) {
				return c.json(
					{
						code: 'commit_failed',
						error: result.err,
						...snapshot(),
					},
					500,
				)
			}

			return c.json({ code: 'success', ...snapshot() }, 200)
		} catch (e: any) {
			const isStart = status === 'start' || status === 'restart'
			const errorCode = isStart ? 'plugin_start_failed' : 'plugin_operation_failed'
			return c.json({ code: errorCode, error: e?.message ?? '未知错误', ...snapshot() }, 500)
		}
	})
