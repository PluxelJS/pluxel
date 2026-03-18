import { describe, expect, it } from 'vitest'

import { BasePlugin, ForkablePlugin, Plugin, withHost } from '@pluxel/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value }),
	},
}

let seen: Array<{ foo: unknown; count: unknown }> = []

@Plugin({ name: 'Cfg' })
class CfgPlugin extends BasePlugin {
	foo = this.configs.use(PassthroughSchema)
	count = this.configs.use(PassthroughSchema)

	override init(): void {
		seen.push({ foo: this.foo, count: this.count })
	}
}

@Plugin({ name: 'ForkCfg' })
class ForkCfg extends ForkablePlugin {
	v = this.configs.use(PassthroughSchema)
}

describe('TestHost config injection', () => {
	it('injects declared config fields before init()', async () => {
		await withHost(async (host) => {
			seen = []

			host.cfg(CfgPlugin).set({ foo: 'hello', count: 42 })
			await host.start(CfgPlugin)

			const instance = host.require(CfgPlugin) as CfgPlugin
			expect(instance.foo).toBe('hello')
			expect(instance.count).toBe(42)
			expect(seen).toEqual([{ foo: 'hello', count: 42 }])
		})
	})

	it('supports fork ids via runtime pluginInfo.id', async () => {
		await withHost(async (host) => {
			host.add(ForkCfg)
			const A = host.fork(ForkCfg, 'a')
			const B = host.fork(ForkCfg, 'b')

			host.cfg(A).set({ v: 'A' })
			host.cfg(B).set({ v: 'B' })

			await host.commit()

			expect(host.require(A).v).toBe('A')
			expect(host.require(B).v).toBe('B')
			expect(host.require(ForkCfg).v).toBeUndefined()
		})
	})
})
