// start.test.ts
import 'reflect-metadata'
import { describe, expect, it } from 'bun:test'

import { Context } from './context'
import { PluginA, PluginB, PluginC } from './plugins'

// 工具函数：读取容器里的插件集合
function readPluginSet(ctx: Context) {
	const { pluginRegistry } = ctx.registry
	const keys = pluginRegistry.lastContainer.services.keys()
	return new Set<any>(keys)
}

describe('Plugin lifecycle with commit()', () => {
	it('should update plugins set across commits', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry

		// 注册 B、C、A
		pluginRegistry.registerPlugin(PluginB)
		pluginRegistry.registerPlugin(PluginC)
		pluginRegistry.registerPlugin(PluginA)
		await ctx.registry.commit()

		// A 依赖 B，C 可选，因此都应存在
		expect(readPluginSet(ctx)).toEqual(new Set([PluginB, PluginC, PluginA]))

		// reload A，再注销 A
		pluginRegistry.reloadPlugin(PluginA)
		pluginRegistry.unregisterPlugin(PluginA)
		await ctx.registry.commit()
		expect(readPluginSet(ctx)).toEqual(new Set([PluginB, PluginC]))

		// 再注册 A
		pluginRegistry.registerPlugin(PluginA)
		await ctx.registry.commit()
		expect(readPluginSet(ctx)).toEqual(new Set([PluginB, PluginC, PluginA]))
		expect(ctx.registry.isRunning(PluginA)).toEqual(true)

		// 最终再次注销 A
		pluginRegistry.unregisterPlugin(PluginA)
		await ctx.registry.commit()
		expect(readPluginSet(ctx)).toEqual(new Set([PluginB, PluginC]))
		expect(ctx.registry.isRunning(PluginA)).toEqual(false)
	})
})
