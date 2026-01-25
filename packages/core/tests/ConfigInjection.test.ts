import { describe, expect, it } from 'bun:test'

import {
	__registerConfigSchema__,
	BasePlugin,
	ForkablePlugin,
	Plugin,
	withTestHost,
} from '@pluxel/core/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value }),
	},
}

describe('TestHost config injection', () => {
	it('injects declared config fields before init()', async () => {
		await withTestHost(async (host) => {
			const seen: Array<{ foo: unknown; count: unknown }> = []

			@Plugin({ name: 'Cfg' })
			class CfgPlugin extends BasePlugin {
				foo = this.configs.use(PassthroughSchema)
				count = this.configs.use(PassthroughSchema)

				override init(): void {
					seen.push({ foo: this.foo, count: this.count })
				}
			}

			__registerConfigSchema__(CfgPlugin, 'foo', PassthroughSchema)
			__registerConfigSchema__(CfgPlugin, 'count', PassthroughSchema)

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
				v = this.configs.use(PassthroughSchema)
			}

			__registerConfigSchema__(ForkCfg, 'v', PassthroughSchema)

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
