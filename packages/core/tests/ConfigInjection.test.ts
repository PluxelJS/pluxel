import { describe, expect, it } from 'vitest'

import { BasePlugin, ForkablePlugin, Plugin, getPluginInfo, withHost } from '@pluxel/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { cfg } from '@pluxel/core'

let validatedInputs: unknown[] = []

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => {
			validatedInputs.push(value)
			return { value }
		},
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

@Plugin({ name: 'CfgGroups' })
class CfgGroups extends BasePlugin {
	private static readonly schemas = {
		a: PassthroughSchema,
		b: PassthroughSchema,
	} as const

	settings = this.configs.use(
		cfg(CfgGroups.schemas),
	)

	override init(): void {
		seen.push({ foo: (this.settings as any).a, count: (this.settings as any).b })
	}
}

@Plugin({ name: 'CfgGroupsWithMd' })
class CfgGroupsWithMd extends BasePlugin {
	private static readonly schemas = {
		a: PassthroughSchema,
		b: PassthroughSchema,
	} as const

	// Markdown is static-only (no runtime callbacks). Interpolation is allowed only for cfg tokens
	// produced by `c.schema(...)` / `c.schemas(...)` (typed schema key refs).
	private static readonly c = cfg(CfgGroupsWithMd.schemas)

	settings = this.configs.use(CfgGroupsWithMd.c`
		# Config Groups
		- a: demo
		- b: demo

		${CfgGroupsWithMd.c.schema('a')}
		${CfgGroupsWithMd.c.schema('b')}

		${CfgGroupsWithMd.c.schemas()}
	`)

	override init(): void {
		seen.push({ foo: (this.settings as any).a, count: (this.settings as any).b })
	}
}

describe('TestHost config injection', () => {
	it('injects declared config fields before init()', async () => {
		const info = getPluginInfo(CfgPlugin as any)
		expect(info.configMap).toBeTruthy()
		expect(info.configBindingsMap).toBeTruthy()

		await withHost(async (host) => {
			seen = []

			const svc1 = host.ctx.configService
			const svc2 = host.ctx.configService
			expect(svc1).toBe(svc2)

			host.cfg(CfgPlugin).set({ foo: 'hello', count: 42 })
			const raw1 = host.ctx.configService.getRawConfig('Cfg') as any
			const raw2 = host.ctx.configService.getRawConfig('Cfg') as any
			expect(raw1).toBe(raw2)
			expect(raw1).toMatchObject({ foo: 'hello', count: 42 })
			expect(raw1.foo).toBe('hello')
			expect(raw1.count).toBe(42)
			expect(host.ctx.configService.getConfigRevision('Cfg')).toBeGreaterThan(0)
			const schemaMap = getPluginInfo(CfgPlugin as any).configMap as any
			expect(Object.keys(schemaMap ?? {}).sort()).toEqual(['count', 'foo'])
			expect(schemaMap.foo).toBe(PassthroughSchema)
			expect(schemaMap.count).toBe(PassthroughSchema)
			expect((PassthroughSchema as any)['~standard']?.validate?.('hello')).toEqual({ value: 'hello' })
			validatedInputs = []
			const snap = await host.ctx.configService.ensureValidated('Cfg', schemaMap)
			expect(host.ctx.configService.getConfigRevision('Cfg')).toBeGreaterThan(0)
			expect(validatedInputs).toEqual(['hello', 42])
			expect(snap).toMatchObject({ foo: 'hello', count: 42 })
			await host.start(CfgPlugin)
			expect(host.ctx.configService.getValidatedConfig('Cfg')).toMatchObject({ foo: 'hello', count: 42 })

			const instance = host.require(CfgPlugin) as CfgPlugin
			expect(instance.ctx.pluginInfo.id).toBe('Cfg')
			expect(instance.foo).toBe('hello')
			expect(instance.count).toBe(42)
			expect(seen).toEqual([{ foo: 'hello', count: 42 }])
		})
	})

	it('injects cfg-bound groups onto a single field', async () => {
		const info = getPluginInfo(CfgGroups as any)
		expect(Object.keys(info.configMap ?? {}).sort()).toEqual(['a', 'b'])
		expect(info.configBindingsMap).toMatchObject({ settings: ['a', 'b'] })

		await withHost(async (host) => {
			seen = []

			host.cfg(CfgGroups).set({ a: 'hello', b: 42 })
			await host.start(CfgGroups)

			const instance = host.require(CfgGroups) as CfgGroups
			expect((instance.settings as any).a).toBe('hello')
			expect((instance.settings as any).b).toBe(42)
			expect(seen).toEqual([{ foo: 'hello', count: 42 }])
		})
	})

	it('supports static markdown in cfg(schemaMap)`...`', async () => {
		const info = getPluginInfo(CfgGroupsWithMd as any)
		expect(Object.keys(info.configMap ?? {}).sort()).toEqual(['a', 'b'])
		expect(info.configBindingsMap).toMatchObject({ settings: ['a', 'b'] })

		await withHost(async (host) => {
			seen = []

			host.cfg(CfgGroupsWithMd).set({ a: 'hello', b: 42 })
			await host.start(CfgGroupsWithMd)

			const instance = host.require(CfgGroupsWithMd) as CfgGroupsWithMd
			expect((instance.settings as any).a).toBe('hello')
			expect((instance.settings as any).b).toBe(42)
			expect(seen).toEqual([{ foo: 'hello', count: 42 }])
		})
	})

	it('rejects duplicate or unreachable cfg layout placements', () => {
		const c = cfg({
			a: PassthroughSchema,
			b: PassthroughSchema,
		} as const)

		expect(() => c`${c.schema('a')}${c.schema('a')}`).toThrowError(/duplicate schema placement/)
		expect(() => c`${c.schemas()}${c.schema('a')}`).toThrowError(/must be the last schema-placement token/)
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
