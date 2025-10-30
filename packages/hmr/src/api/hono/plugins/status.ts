import { vValidator } from '@hono/valibot-validator'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { PluginsEnv } from '.'

// 校验 Schema
const updateStatusSchema = v.object({
	status: v.picklist(['start', 'stop', 'restart']),
})
type UpdateStatusPayload = v.InferOutput<typeof updateStatusSchema>
type Status = UpdateStatusPayload['status']

// 定义全局操作映射，避免每次请求重新创建
const statusOps: Record<Status, Array<'enable' | 'disable'>> = {
	start: ['enable'],
	stop: ['disable'],
	restart: ['disable', 'enable'],
}

export const pluginStatus = new Hono<PluginsEnv>()
	.get('/', (c) => {
		const { plugin_ctx: ctx, pluginCtor: ctor } = c.var
		return c.json({ code: 'success', isRunning: ctx.loader.isRunning(ctor) })
	})
	.post('/', vValidator('json', updateStatusSchema), async (c) => {
		const { status } = c.req.valid('json') as UpdateStatusPayload
		const { plugin_ctx: ctx, pluginCtor: ctor, pluginName } = c.var

		const registry = ctx.loader.registry
		// 可选：避免无效操作，跳过并快速返回
		// if (status === 'start' && registry.isPluginEnabled(pluginName)) {
		//   return c.json({ code: 'no_change', status }, 200)
		// }
		// if (status === 'stop' && !registry.isPluginEnabled(pluginName)) {
		//   return c.json({ code: 'no_change', status }, 200)
		// }
		const ops = statusOps[status]
		if (!ops) {
			return c.json({ code: 'invalid_status', error: `不支持的状态：${status}` }, 400)
		}

		try {
			// 执行操作，无需每次创建闭包
			for (const action of ops) {
				if (action === 'enable') {
					registry.enable(pluginName, ctor)
				} else {
					registry.deactivate(pluginName, ctor, { runtimeOnly: false })
				}
			}
			// 一次性提交所有变更
			const result = await ctx.registry.commit()
			if (result.err) {
				return c.json({ code: '依赖解析出错。', error: result.err }, 500)
			}

			return c.json({ code: 'success', isRunning: ctx.loader.isRunning(ctor) }, 200)
		} catch (e: any) {
			const isStart = status === 'start' || status === 'restart'
			const errorCode = isStart ? 'plugin_start_failed' : 'plugin_operation_failed'
			return c.json({ code: errorCode, error: e?.message ?? '未知错误' }, 500)
		}
	})
