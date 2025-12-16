import { describe, expect, it } from 'bun:test'

import { BasePlugin, Config, ForkablePlugin, Plugin, withTestHost } from '@pluxel/core/test'

describe('TestHost config injection', () => {
	it('injects @Config fields before init()', async () => {
		await withTestHost(async (host) => {
			const seen: Array<{ foo: unknown; count: unknown }> = []

			@Plugin({ name: 'Cfg' })
			class CfgPlugin extends BasePlugin {
				@Config({}) foo!: string
				@Config({}) count!: number

				override init(): void {
					seen.push({ foo: this.foo, count: this.count })
				}
			}

			host.setConfig(CfgPlugin, { foo: 'hello', count: 42 })
			await host.start(CfgPlugin)

			const instance = host.getOrThrow(CfgPlugin) as CfgPlugin
			expect(instance.foo).toBe('hello')
			expect(instance.count).toBe(42)
			expect(seen).toEqual([{ foo: 'hello', count: 42 }])
		})
	})

	it('supports fork ids via runtime pluginInfo.id', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'ForkCfg' })
			class ForkCfg extends ForkablePlugin {
				@Config({}) v!: string
			}

			host.register(ForkCfg)
			host.registerFork(ForkCfg, 'a')
			host.registerFork(ForkCfg, 'b')

			host.setConfig('ForkCfg#a', { v: 'A' })
			host.setConfig('ForkCfg#b', { v: 'B' })

			await host.commitStrict()

			expect(host.getFork(ForkCfg, 'a')!.v).toBe('A')
			expect(host.getFork(ForkCfg, 'b')!.v).toBe('B')
			expect(host.getOrThrow(ForkCfg).v).toBeUndefined()
		})
	})
})
