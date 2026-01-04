// start.ts
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configure } from '@logtape/logtape'
import { createPluxelPrettyConsoleSink, getRotatingFileSink } from '@pluxel/core/logger'
import { Context } from '@pluxel/core/test'
import { PluginA, PluginB, PluginC } from './plugins'

const logsDir = join(dirname(fileURLToPath(import.meta.url)), '../logs')
await mkdir(logsDir, { recursive: true })

await configure({
	sinks: {
		console: createPluxelPrettyConsoleSink({
			pretty: { timestamp: 'time', prefix: 'context', includeCaller: true },
			youch: { minLevel: 'error' },
		}),
		file: getRotatingFileSink(join(logsDir, 'core.log')),
	},
	loggers: [
		{ category: ['pluxel'], sinks: ['console', 'file'], lowestLevel: process.env.PLUXEL_LOG_LEVEL ?? 'info' },
		{ category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'error' },
	],
})

const ctx = new Context()

// 注册插件，假设 PluginA 必需依赖 PluginB
// 如果缺少必需依赖（例如未注册 PluginB），PluginA 将因解析失败而不加载
ctx.registry.register(PluginB)
ctx.registry.register(PluginC) // PluginC 为可选依赖，可注册也可不注册
ctx.registry.register(PluginA)

await ctx.registry.commit()
// 提交本周期，构建 diod 容器后依次初始化插件

ctx.registry.restart(PluginA)
ctx.registry.unregister(PluginA)

await ctx.registry.commit()

ctx.registry.register(PluginA)

await ctx.registry.commit()

ctx.registry.unregister(PluginA)

await ctx.registry.commit()
