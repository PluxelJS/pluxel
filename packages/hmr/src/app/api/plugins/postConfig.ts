// src/plugins.ts
import { Hono } from 'hono'
import type { AppEnv } from '../../../services/hono/env'
import * as v from 'valibot'
import { vValidator } from '@hono/valibot-validator'

const pluginConfigSchema = v.object({
	isSubmitAction: v.boolean(),
	formData: v.record(
		v.string(),
		v.looseObject({}, 'Each value must be an object'),
		'Input must be an object of objects',
	),
})
type PluginConfigPayload = v.InferOutput<typeof pluginConfigSchema>

type PluginPostResponse =
	| { code: 'plugin_not_found'; error: string }
	| { code: 'config_not_found'; error: string }
	| { code: 'validation_error'; errors: Record<string, Record<string, string>> }
	| { code: 'success'; message: string }

export const pluginsPostConfig = new Hono<AppEnv>()
	.get('/config/:name', (c) => {
		const pluginName = c.req.param('name')
		const ctx = c.var.plugin_ctx
		const ctor = ctx.loader.getPluginClassByName(pluginName)

		if (!ctor) {
			return c.json<PluginPostResponse>(
				{ code: 'plugin_not_found', error: '插件未找到' },
				404,
			)
		}

		return c.json(ctx.configService.getConfig(pluginName))
	})
	.post('/:name', vValidator('json', pluginConfigSchema), async (c) => {
		const pluginName = c.req.param('name')
		const ctx = c.var.plugin_ctx
		const ctor = ctx.loader.getPluginClassByName(pluginName)

		if (!ctor) {
			return c.json<PluginPostResponse>(
				{ code: 'plugin_not_found', error: '插件未找到' },
				404,
			)
		}

		const configChecker = ctx.loader.getPluginSchema(ctor)
		if (!configChecker) {
			return c.json<PluginPostResponse>(
				{ code: 'config_not_found', error: '该插件没有定义配置检查' },
				403,
			)
		}

		const inputData = c.req.valid('json') as PluginConfigPayload

		// → 嵌套结构：每个 configKey 对应一个子对象，里面按属性名汇总错误
		const errors: Record<string, any> = {}

		for (const [configKey, data] of Object.entries(inputData.formData)) {
			const schema = configChecker[configKey]
			if (!schema) {
				2
				// 整个配置项都不存在
				errors[configKey] = { _error: `未知配置项 ${configKey}` }
				continue
			}

			const result = v.safeParse(schema, data)
			if (result.success) {
				continue
			}
			// Issue 的类型定义，方便后面复用
			type Issue = (typeof result.issues)[number]

			// 最终要返回的字段错误对象：key 是字段名，value 是对应的 issue
			const fieldErrors: Record<string, Issue[]> = {}

			for (const issue of result.issues) {
				// issue.path 是一个数组，每一项都可能有 key 属性
				const path = issue.path ?? []

				// 取最后一段，如果没有则归为 '_error'
				const last = path[path.length - 1] as { key?: string } | undefined
				const propName = last?.key ?? '_error'

				// 如果还没有数组，则先初始化
				if (!fieldErrors[propName]) {
					fieldErrors[propName] = []
				}
				// 然后把当前 issue push 进去
				fieldErrors[propName].push(issue)
			}
			errors[configKey] = fieldErrors
		}

		if (Object.keys(errors).length > 0) {
			return c.json<PluginPostResponse>(
				{ code: 'validation_error', errors },
				422,
			)
		}

		if (inputData.isSubmitAction) {
			// 1. 直接把 formData 作为 config 对象整体提交
			// 2. 如果有字段需要过滤 undefined，可用 Object.fromEntries 先清洗一遍
			const entries = Object.entries(inputData.formData).filter(
				([, v]) => v !== undefined && v !== null,
			)

			const cleanConfig = Object.fromEntries(entries)

			// 一次性更新所有字段
			ctx.configService.setConfig(pluginName, {
				configRecord: cleanConfig,
			})
		}

		return c.json<PluginPostResponse>(
			{ code: 'success', message: '验证通过。' },
			200,
		)
	})
