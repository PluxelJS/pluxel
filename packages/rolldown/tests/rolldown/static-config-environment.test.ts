import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { createConfigSchemaSourceResolver } from '../../src/rolldown/plugins/configSourcePlugin'
import { parseStaticRuntimeDeclaration } from '../../src/rolldown/plugins/staticConfigEnvironment'
import { parseStandaloneWithLang } from '../../src/rolldown/plugins/pluginUtils'

function staticEntry(options: { bindings: string; plugins?: string; extra?: string }): string {
	return `
import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
		import { AlphaConfig, AlphaVault, AlphaPlugin, BetaConfig, BetaPlugin, examplePlugins } from './plugins'
		${options.extra ?? ''}
		export default defineConfig(() => ({
			name: 'fixture',
			plugins: ${options.plugins ?? '[AlphaPlugin, BetaPlugin]'},
			envBindings: ${options.bindings},
		}))
	`
}

async function parseFixture(code: string, requireStaticPlugins = false) {
	await using fixture = await createFixture({
		'schemas.ts': `
			import * as v from 'valibot'
			import * as f from 'valibot-form'
			export const AlphaConfig = v.object({
				endpoint: v.pipe(v.string(), v.url(), f.formMeta({ description: 'Zulu endpoint.' })),
				count: v.pipe(v.number(), v.integer(), v.minValue(1)),
			})
			export const BetaConfig = v.object({
				endpoint: v.pipe(v.string(), v.description('Alpha endpoint.')),
				unknown: v.unknown(),
			})
		`,
		'plugins.ts': `
			import * as v from 'valibot'
			import { AlphaConfig, BetaConfig } from './schemas'
			export * from './schemas'
			export const AlphaVault = v.object({ token: v.string(), account: v.object({ password: v.string() }) })
			export class AlphaPlugin {

				readonly settings = this.configs.use(AlphaConfig)
			}
			export class BetaPlugin {

				readonly settings = this.configs.use(BetaConfig)
			}
			export const examplePlugins = [AlphaPlugin, BetaPlugin] as const
		`,
		'other-plugins.ts': `
			export class AlphaPlugin {}
			export const otherPlugins = [AlphaPlugin] as const
		`,
		'entry.ts': code,
	})
	const id = fixture.getPath('entry.ts')
	const ast = parseStandaloneWithLang(code, id)
	if (!ast) throw new Error('fixture did not parse')
	return await parseStaticRuntimeDeclaration({
		requireStaticPlugins,
		ast,
		code,
		id,
		sourceResolver: createConfigSchemaSourceResolver({
			async resolve(source: string, importer: string) {
				if (!source.startsWith('.')) return null
				const base = resolve(dirname(importer), source)
				return { id: base.endsWith('.ts') ? base : `${base}.ts` }
			},
		} as never),
		error(message): never {
			throw new Error(message)
		},
	})
}

describe('static config environment declaration lowering', () => {
	it('accepts the public Host consumer fixture as a static application entry', async () => {
		const consumer = await readFile(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				'../../../../engineering/experiments/tsgo-plugin-inputs/production-consumer.ts',
			),
			'utf8',
		)
		const result = await parseFixture(consumer, true)
		expect(result.targets).toHaveLength(5)
		expect(result.environmentExample).toContain('RAW')
		expect(result.environmentExample).toContain('TOKEN')
	})

	it('requires a direct factory and rejects hidden fields', async () => {
		await expect(parseFixture(`export default { plugins: [] }`)).rejects.toThrow(
			'must default-export defineConfig(factory)',
		)
		await expect(
			parseFixture(`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			const base = { plugins: [] }
			export default defineConfig(() => ({ ...base, name: 'spread' }))
		`),
		).rejects.toThrow('does not allow spread properties')
	})

	it('reads an asynchronous factory without running preparation or nested callbacks', async () => {
		const result = await parseFixture(`
			import { defineConfig as application } from '@pluxel/host'
			export default application(async (startup) => {
				throw new Error('FACTORY_MUST_NOT_EXECUTE')
				return { name: 'async', plugins: [], services: await prepare(startup), prepare() { return undefined } }
			})
		`)
		expect(result).toEqual({ name: 'async', targets: [], hasSources: false })
	})

	it.each([
		`() => { if (flag) return { plugins: [] }; return { plugins: [] } }`,
		`() => flag ? { plugins: [] } : { plugins: [] }`,
		`() => { try { return { plugins: [] } } finally {} }`,
	])('rejects factory results whose complete declaration cannot be proven: %s', async (factory) => {
		await expect(
			parseFixture(
				`import { defineConfig, envBinding, fileBinding } from '@pluxel/host'; export default defineConfig(${factory})`,
			),
		).rejects.toThrow(/factory must/)
	})

	it('rejects conditional production catalogs without evaluating startup', async () => {
		await expect(
			parseFixture(
				`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			import { AlphaPlugin, BetaPlugin } from './plugins'
			export default defineConfig((startup) => ({ plugins: startup.env.BETA ? [BetaPlugin] : [AlphaPlugin] }))
		`,
				true,
			),
		).rejects.toThrow('outside the static deployment contract')
	})

	it('does not mistake factory-local shadowing for the module catalog', async () => {
		await expect(
			parseFixture(
				`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins } from './plugins'
			export default defineConfig(({ examplePlugins }) => ({ plugins: examplePlugins }))
		`,
				true,
			),
		).rejects.toThrow('outside the static deployment contract')
	})

	it.each([
		`plugins.push((await import(startup.env.MODULE)).Plugin)`,
		`plugins[0] = startup.bindings.Plugin`,
		`plugins.length++`,
		`delete plugins[0]`,
		`plugins.sort()`,
		`configure(plugins)`,
		`const alias = plugins`,
	])('rejects explicit mutation or escape of a static catalog: %s', async (preparation) => {
		await expect(
			parseFixture(
				`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins as plugins } from './plugins'
			export default defineConfig(async (startup) => { ${preparation}; return {plugins} })
		`,
				true,
			),
		).rejects.toThrow('must remain immutable')
	})

	it.each([
		`try { throw 1 } catch (plugins) { configure(plugins) }`,
		`{ const plugins = []; plugins.push('local') }`,
		`{ class plugins {}; configure(plugins) }`,
		`for (const plugins of []) { configure(plugins) }`,
		`const addresses = plugins.map(pluginNodeAddressOf)`,
	])(
		'preserves module catalog identity across independent scopes and reads: %s',
		async (preparation) => {
			await expect(
				parseFixture(
					`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins as plugins } from './plugins'
			export default defineConfig(() => { ${preparation}; return {plugins} })
		`,
					true,
				),
			).resolves.toMatchObject({ hasSources: false })
		},
	)

	it.each([
		`function plugins() { return {plugins} }`,
		`() => { class plugins {}; return {plugins} }`,
		`() => { { var plugins = [] }; return {plugins} }`,
		`({bindings: {plugins}}) => ({plugins})`,
	])('rejects factory bindings that shadow the module catalog: %s', async (factory) => {
		await expect(
			parseFixture(
				`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins as plugins } from './plugins'
			export default defineConfig(${factory})
		`,
				true,
			),
		).rejects.toThrow('outside the static deployment contract')
	})

	it('derives config and Vault transports from explicit schemas without reading bound files', async () => {
		const facts = await parseFixture(
			`
			import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
			import { AlphaPlugin, AlphaConfig, AlphaVault } from './plugins'
			export default defineConfig(() => ({
				plugins: [AlphaPlugin],
				fileBindings: [fileBinding(AlphaPlugin, {config:{schema:AlphaConfig,path:'/must/not/read.json'}, vault:{schema:AlphaVault,paths:{token:'/must/not/read.secret'}}})],
				envBindings: [envBinding(AlphaPlugin, {namespace:'account-a', config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'}}, vault:{schema:AlphaVault,mapping:{token:'APP_TOKEN', account:{password:'APP_PASSWORD'}}}})],
			}))
		`,
			true,
		)
		expect(
			facts.targets.map((target) => [target.kind, target.path, target.projection.transport]),
		).toEqual([
			['config', ['endpoint'], 'string'],
			['vault', ['token'], 'string'],
			['vault', ['account', 'password'], 'string'],
		])
		expect(facts.environmentExample).toContain('# APP_TOKEN=')
		expect(facts.environmentExample).not.toContain('/must/not/read')
	})

	it('resolves an aliased helper and inline schema without class static metadata', async () => {
		const facts = await parseFixture(`
			import { defineConfig, envBinding as bind } from '@pluxel/host'
			import { AlphaPlugin } from './plugins'
			import * as v from 'valibot'
			export default defineConfig(() => ({ plugins: [AlphaPlugin], envBindings: [
				bind(AlphaPlugin, {config: {schema: v.object({name: v.string()}), mapping: {name: 'APP_NAME'}}})
			]}))
		`)
		expect(facts.targets[0]).toMatchObject({ environmentName: 'APP_NAME', path: ['name'] })
	})

	it.each([
		["[{plugin: AlphaPlugin, config:{endpoint:'APP_ENDPOINT'}}]", 'must call envBinding'],
		[
			"[envBinding(AlphaPlugin, {config:{mapping:{endpoint:'APP_ENDPOINT'}}})]",
			'requires schema and mapping',
		],
		[
			"[envBinding(AlphaPlugin, {config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'},extra:true}})]",
			'unknown config binding field',
		],
		[
			"[envBinding(AlphaPlugin, {vault:{schema:AlphaVault,mapping:'APP_VAULT'}})]",
			'must declare record keys directly',
		],
		[
			"[envBinding(AlphaPlugin, {vault:{schema:AlphaVault,mapping:{missing:'APP_TOKEN'}}})]",
			'is not declared by the Vault binding schema',
		],
	])('rejects malformed explicit bindings: %s', async (bindings, message) => {
		await expect(parseFixture(staticEntry({ bindings }))).rejects.toThrow(message)
	})

	it('rejects factory-local helpers that shadow the imported binding authority', async () => {
		await expect(
			parseFixture(`
			import { defineConfig, envBinding } from '@pluxel/host'
			import { AlphaPlugin, AlphaConfig } from './plugins'
			export default defineConfig((envBinding) => ({plugins:[AlphaPlugin],envBindings:[
				envBinding(AlphaPlugin,{config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'}}})
			]}))
		`),
		).rejects.toThrow('must call envBinding imported from @pluxel/host directly')
	})

	it('preserves module schema identity when a factory shadows the schema import', async () => {
		await expect(
			parseFixture(`
			import { defineConfig, envBinding } from '@pluxel/host'
			import { AlphaPlugin, AlphaConfig } from './plugins'
			export default defineConfig((AlphaConfig) => ({plugins:[AlphaPlugin],envBindings:[
				envBinding(AlphaPlugin,{config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'}}})
			]}))
		`),
		).rejects.toThrow(/AlphaConfig/)
	})

	it('accepts explicit framework-prefixed names as ordinary declared bindings', async () => {
		const facts = await parseFixture(
			staticEntry({
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: {endpoint:'PLUXEL_CUSTOM_ENDPOINT'} } })]",
			}),
		)
		expect(facts.environmentExample).toContain('# PLUXEL_CUSTOM_ENDPOINT=')
	})

	it('uses source resolution and raw-input projection to render deterministic fan-out', async () => {
		const code = staticEntry({
			bindings: `[
				envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: {
					count: 'APP_COUNT',
					endpoint: 'APP_ENDPOINT',
				} } }),
				envBinding(BetaPlugin, { config: { schema: BetaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } }),
			]`,
		})
		const first = await parseFixture(code)
		const second = await parseFixture(code)

		expect(first.environmentExample).toBe(second.environmentExample)
		expect(first.environmentExample).toBe(
			[
				'# Generated Pluxel config and Vault environment bindings.',
				'# Present environment values override saved and base values; they are never persisted.',
				'',
				'# count',
				'# Input: number (finite integer, >= 1)',
				'# APP_COUNT=',
				'',
				'# Alpha endpoint.',
				'# Zulu endpoint.',
				'# Input: string',
				'# Input: string (URL)',
				'# APP_ENDPOINT=',
				'',
			].join('\n'),
		)
		expect(first.targets).toHaveLength(3)
	})

	it('supports a starter-style imported const Plugin catalog without executing it', async () => {
		const facts = await parseFixture(
			staticEntry({
				plugins: 'examplePlugins',
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } })]",
			}),
			true,
		)
		expect(facts.targets).toHaveLength(1)
		expect(facts.environmentExample).toContain('# APP_ENDPOINT=')
	})

	it('accepts an imported Plugin alias by canonical source binding identity', async () => {
		const facts = await parseFixture(
			staticEntry({
				extra: `import { AlphaPlugin as ConfiguredAlpha } from './plugins'`,
				plugins: 'examplePlugins',
				bindings:
					"[envBinding(ConfiguredAlpha, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } })]",
			}),
		)

		expect(facts.targets).toHaveLength(1)
		expect(facts.targets[0]?.pluginName).toBe('ConfiguredAlpha')
	})

	it('rejects a same-named Plugin from a different catalog module', async () => {
		await expect(
			parseFixture(
				staticEntry({
					extra: `import { otherPlugins } from './other-plugins'`,
					plugins: 'otherPlugins',
					bindings:
						"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } })]",
				}),
			),
		).rejects.toThrow('is not present in the statically resolved plugins catalog')
	})

	it.each([
		{
			name: 'indirect array',
			code: staticEntry({
				extra: `const declarations = [envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: 'APP_CONFIG' } })]`,
				bindings: 'declarations',
			}),
			message: 'must be a direct array literal',
		},
		{
			name: 'indirect bind',
			code: staticEntry({
				extra: `const declaration = envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: 'APP_CONFIG' } })`,
				bindings: '[declaration]',
			}),
			message: 'must call envBinding imported from @pluxel/host directly',
		},
		{
			name: 'spread element',
			code: staticEntry({ bindings: '[...[]]' }),
			message: 'must call envBinding imported from @pluxel/host directly',
		},
		{
			name: 'indirect mapping',
			code: staticEntry({
				extra: `const mapping = { endpoint: 'APP_ENDPOINT' }`,
				bindings:
					'[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: mapping } })]',
			}),
			message: 'must be a direct environment name string or object literal',
		},
		{
			name: 'mapping spread',
			code: staticEntry({
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { ...{ endpoint: 'APP_ENDPOINT' } } } })]",
			}),
			message: 'does not allow spread properties',
		},
		{
			name: 'computed key',
			code: staticEntry({
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { ['endpoint']: 'APP_ENDPOINT' } } })]",
			}),
			message: 'must use a direct key',
		},
		{
			name: 'duplicate key',
			code: staticEntry({
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_A', endpoint: 'APP_B' } } })]",
			}),
			message: 'contains duplicate key "endpoint"',
		},
		{
			name: 'non-portable name',
			code: staticEntry({
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'app-endpoint' } } })]",
			}),
			message: 'must match [A-Z_][A-Z0-9_]*',
		},
		{
			name: 'duplicate Plugin binding',
			code: staticEntry({
				bindings: `[
					envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_A' } } }),
					envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_B' } } }),
				]`,
			}),
			message: 'duplicate environment target for Plugin AlphaPlugin',
		},
		{
			name: 'unknown catalog Plugin',
			code: staticEntry({
				plugins: '[BetaPlugin]',
				bindings:
					"[envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } })]",
			}),
			message: 'is not present in the statically resolved plugins catalog',
		},
	])('rejects $name with one direct-declaration diagnostic', async ({ code, message }) => {
		await expect(parseFixture(code)).rejects.toThrow(message)
	})

	it('rejects conflicting fan-out transports and unsupported raw shapes', async () => {
		await expect(
			parseFixture(
				staticEntry({
					bindings: `[
						envBinding(AlphaPlugin, { config: { schema: AlphaConfig, mapping: { count: 'APP_SHARED' } } }),
						envBinding(BetaPlugin, { config: { schema: BetaConfig, mapping: { endpoint: 'APP_SHARED' } } }),
					]`,
				}),
			),
		).rejects.toThrow('conflicting derived transports number and string')

		await expect(
			parseFixture(
				staticEntry({
					bindings:
						"[envBinding(BetaPlugin, { config: { schema: BetaConfig, mapping: { unknown: 'APP_UNKNOWN' } } })]",
				}),
			),
		).rejects.toThrow('Raw input transport cannot be derived from schema type unknown')
	})

	it('fails closed instead of executing an arbitrary schema helper', async () => {
		await using fixture = await createFixture({
			'schema.ts': `
				export function makeSchema() { throw new Error('must not execute') }
				export const UnsafeConfig = makeSchema()
				export class UnsafePlugin {

				readonly settings = this.configs.use(UnsafeConfig)
				}
			`,
			'entry.ts': `
import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
				import { UnsafeConfig, UnsafePlugin } from './schema'
				export default defineConfig(() => ({
					name: 'unsafe',
					plugins: [UnsafePlugin],
					envBindings: [envBinding(UnsafePlugin, { config: { schema: UnsafeConfig, mapping: 'APP_CONFIG' } })],
				}))
			`,
		})
		const id = fixture.getPath('entry.ts')
		const code = await readFile(id, 'utf8')
		const ast = parseStandaloneWithLang(code, id)!
		await expect(
			parseStaticRuntimeDeclaration({
				ast,
				code,
				id,
				sourceResolver: createConfigSchemaSourceResolver({
					async resolve(source: string) {
						return source === './schema' ? { id: fixture.getPath('schema.ts') } : null
					},
				} as never),
				error(message): never {
					throw new Error(message)
				},
			}),
		).rejects.toThrow('only direct Valibot and valibot-form factory calls are allowed')
	})

	it('allows only an explicit inert Valibot factory set', async () => {
		await using fixture = await createFixture({
			'schema.ts': `
				import * as v from 'valibot'
				export const UnsafeConfig = v.getDescription(v.object({ endpoint: v.string() }))
				export class UnsafePlugin {

				readonly settings = this.configs.use(UnsafeConfig)
				}
			`,
			'entry.ts': `
import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
				import { UnsafeConfig, UnsafePlugin } from './schema'
				export default defineConfig(() => ({
					name: 'unsafe-valibot-method',
					plugins: [UnsafePlugin],
					envBindings: [envBinding(UnsafePlugin, { config: { schema: UnsafeConfig, mapping: 'APP_CONFIG' } })],
				}))
			`,
		})
		const id = fixture.getPath('entry.ts')
		const code = await readFile(id, 'utf8')
		const ast = parseStandaloneWithLang(code, id)!
		await expect(
			parseStaticRuntimeDeclaration({
				ast,
				code,
				id,
				sourceResolver: createConfigSchemaSourceResolver({
					async resolve(source: string) {
						return source === './schema' ? { id: fixture.getPath('schema.ts') } : null
					},
				} as never),
				error(message): never {
					throw new Error(message)
				},
			}),
		).rejects.toThrow('Valibot method v.getDescription is not an allowed inert schema factory')
	})
})
