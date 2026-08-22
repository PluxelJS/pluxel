import { createFixture } from 'fs-fixture'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { configSourcePlugin } from '../../src/rolldown/plugins/configSourcePlugin'

async function transform(
	code: string,
	helper?: string,
	options: {
		id?: string
		resolve?: (source: string, importer: string) => Promise<{ id: string } | null>
	} = {},
) {
	const plugin = configSourcePlugin(helper ? { metadataHelperImportSource: helper } : undefined)
	const hook = plugin.transform as {
		handler: (this: unknown, code: string, id: string) => unknown
	}
	return (await hook.handler.call(
		{
			error(message: string): never {
				throw new Error(message)
			},
			resolve: options.resolve,
		},
		code,
		options.id ?? '/repo/src/plugin.ts',
	)) as { code: string; map: null } | null
}

describe('configSourcePlugin', () => {
	it('lowers Plugin and PluginPart config declarations to their distinct owners', async () => {
		const result = await transform(`
			import * as v from 'valibot'
			import { BasePlugin, Plugin, PluginPart } from '@pluxel/runtime'
			const PartConfig = v.object({ size: v.optional(v.number(), 10) })
			class CachePart extends PluginPart<OwnerPlugin> {
				readonly config = this.configs.use(PartConfig)
			}
			@Plugin() class OwnerPlugin extends BasePlugin {
				readonly config = this.configs.use(v.object({ enabled: v.boolean() }))
			}
		`)

		expect(result?.code).toContain('__setPluginPartConfig as __pluxelSetPluginPartConfig')
		expect(result?.code).toContain(
			'__pluxelSetPluginPartConfig(CachePart, { abiVersion: 1, fieldName: "config"',
		)
		expect(result?.code).toContain(
			'__pluxelSetPluginConfig(OwnerPlugin, { abiVersion: 1, fieldName: "config"',
		)
	})

	it('keeps Vite/Rolldown object hook filtering compatible', () => {
		const hook = configSourcePlugin().transform
		expect(hook).toBeTypeOf('object')
		expect((hook as { filter?: { code?: unknown } }).filter?.code).toBeUndefined()
	})

	it('lowers one object config schema to the unified Plugin config fact', async () => {
		const result = await transform(`
			import * as v from 'valibot'
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			const OrdersConfig = v.object({ batchSize: v.optional(v.number(), 10) })
			@Plugin({ displayName: 'Orders' })
			export class OrdersPlugin extends BasePlugin {
				private readonly config = this.configs.use(OrdersConfig)
			}
		`)

		expect(result?.code).toContain('// [pluxel-config] Injected definition')
		expect(result?.code).toContain(
			'import { __setPluginConfig as __pluxelSetPluginConfig } from "@pluxel/runtime/toolchain"',
		)
		expect(result?.code).toContain(
			'__pluxelSetPluginConfig(OrdersPlugin, { abiVersion: 1, fieldName: "config", schema: OrdersConfig, source: "v.object({batchSize:v.optional(v.number(),10)})" })',
		)
		expect(result?.code).not.toContain('__registerConfigBinding__')
		expect(result?.code).not.toContain('__setConfigLayout__')
	})

	it('preserves the existing normalized schema-source transport across modules', async () => {
		await using fixture = await createFixture({
			'schema.ts': `
				import * as valibot from 'valibot'
				const Enabled = valibot.boolean()
				export const OrdersConfig = valibot.object({ enabled: Enabled })
			`,
			'plugin.ts': `
				import { OrdersConfig } from './schema'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class OrdersPlugin extends BasePlugin {
					config = this.configs.use(OrdersConfig)
				}
			`,
		})
		const id = fixture.getPath('plugin.ts')
		const code = await readFile(id, 'utf8')
		const result = await transform(code, undefined, {
			id,
			resolve: async (source) =>
				source === './schema' ? { id: fixture.getPath('schema.ts') } : null,
		})

		expect(result?.code).toContain('schema: OrdersConfig')
		expect(result?.code).toContain('source: "v.object({enabled:v.boolean()})"')
	})

	it('canonicalizes named Valibot and valibot-form imports for the Workbench renderer', async () => {
		const result = await transform(`
			import { object, pipe, string } from 'valibot'
			import { stringMeta as meta } from 'valibot-form'
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			const Schema = object({ name: pipe(string(), meta({ label: 'Name' })) })
			@Plugin() export class P extends BasePlugin {
				config = this.configs.use(Schema)
			}
		`)

		expect(result?.code).toContain(
			'source: "v.object({name:v.pipe(v.string(),f.stringMeta({label:\'Name\'}))})"',
		)
	})

	it('supports an explicit internal helper import', async () => {
		const result = await transform(
			`
				import * as v from 'valibot'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class P extends BasePlugin {
					config = this.configs.use(v.object({ enabled: v.boolean() }))
				}
			`,
			'@scope/runtime/toolchain',
		)
		expect(result?.code).toContain('from "@scope/runtime/toolchain"')
	})

	it('rejects a generated-helper root alias', () => {
		expect(() => configSourcePlugin({ metadataHelperImportSource: '@pluxel/runtime' })).toThrow(
			'/toolchain subpath',
		)
	})

	it.each(['@pluxel/core/test', '@pluxel/runtime/test', '@pluxel/test'])(
		'recognizes the formal test authoring facade %s',
		async (source) => {
			const result = await transform(`
				import * as v from 'valibot'
				import { BasePlugin, Plugin } from '${source}'
				@Plugin() export class P extends BasePlugin {
					config = this.configs.use(v.object({ enabled: v.boolean() }))
				}
			`)
			expect(result?.code).toContain('__pluxelSetPluginConfig(P')
		},
	)

	it.each([
		{
			name: 'two schemas',
			code: `
				import * as v from 'valibot'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class P extends BasePlugin {
					a = this.configs.use(v.object({ a: v.string() }))
					b = this.configs.use(v.object({ b: v.string() }))
				}
			`,
			message: 'at most one ObjectSchema',
		},
		{
			name: '#private config',
			code: `
				import * as v from 'valibot'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class P extends BasePlugin {
					#config = this.configs.use(v.object({ a: v.string() }))
				}
			`,
			message: 'must not use #private',
		},
		{
			name: 'unmarked config owner',
			code: `
				import * as v from 'valibot'
				class Feature { config = this.configs.use(v.object({ a: v.string() })) }
			`,
			message: 'is not a concrete @Plugin',
		},
		{
			name: 'scalar schema',
			code: `
				import * as v from 'valibot'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class P extends BasePlugin {
					config = this.configs.use(v.string())
				}
			`,
			message: 'must use a valibot ObjectSchema',
		},
		{
			name: '@Config decorator',
			code: `
				import { Config } from '@pluxel/runtime'
				class P { @Config(Schema) config: unknown }
			`,
			message: 'removed Config authoring DSL',
		},
		{
			name: 'cfg layout',
			code: `
				import { cfg } from '@pluxel/runtime'
				const schema = cfg({ a: A })
			`,
			message: 'removed cfg authoring DSL',
		},
	])('rejects $name', async ({ code, message }) => {
		await expect(transform(code)).rejects.toThrow(message)
	})

	it('does not confuse test-host config handles with the removed cfg authoring helper', async () => {
		const result = await transform('host.cfg(PluginA).set({ enabled: true })')
		expect(result).toBeNull()
	})

	it('ignores unrelated cfg parameters and comments', async () => {
		const result = await transform(
			'/** `cfg` is a service constructor parameter. */\n' +
				'type ServiceCtor = new (ctx: unknown, cfg?: unknown) => unknown',
		)
		expect(result).toBeNull()
	})
})
