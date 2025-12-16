// start.test.ts
import { describe, expect, it } from 'bun:test'

import { withPluginTestHost } from '@pluxel/core/test'
import { PluginA, PluginB, PluginC } from './plugins'

describe('Plugin lifecycle with commit()', () => {
	it('should update plugins set across commits', async () => {
		await withPluginTestHost(async (host) => {
			const readPluginSet = () => new Set<any>(host.listPlugins())

			// 注册 B、C、A
			host.registerAll(PluginB, PluginC, PluginA)
			await host.commitStrict()

			// A 依赖 B，C 可选，因此都应存在
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC, PluginA]))

			// reload A，再注销 A
			host.reload(PluginA)
			host.unregister(PluginA)
			await host.commitStrict()
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC]))

			// 再注册 A
			host.register(PluginA)
			await host.commitStrict()
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC, PluginA]))
			expect(host.isRunning(PluginA)).toEqual(true)

			// 最终再次注销 A
			host.unregister(PluginA)
			await host.commitStrict()
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC]))
			expect(host.isRunning(PluginA)).toEqual(false)
		})
	})
})
