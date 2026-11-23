import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { createConfigSchemaSourceResolver } from '../../src/rolldown/plugins/configSourcePlugin'
import { parseStaticRuntimeDeclaration } from '../../src/rolldown/plugins/staticConfigEnvironment'
import { parseStandaloneWithLang } from '../../src/rolldown/plugins/pluginUtils'

function staticEntry(options: {
	bindings?: string
	declarations?: string
	extra?: string
}): string {
	return `
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
		import { AlphaConfig, AlphaVault, AlphaPlugin, BetaConfig, BetaPlugin, examplePlugins } from './plugins'
		${options.extra ?? ''}
		export default defineHostApplication(() => ({
			name: 'fixture',
			plugins: ${options.declarations ?? `[{plugin: AlphaPlugin, envBindings: ${options.bindings}}]`},
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
			import { envBinding } from '@pluxel/host'
			import { AlphaConfig, BetaConfig } from './schemas'
			export * from './schemas'
			export const AlphaVault = v.object({ token: v.string(), account: v.object({ password: v.string() }) })
			export class AlphaPlugin {

				readonly settings = this.configs.use(AlphaConfig)
			}
			export class BetaPlugin {

				readonly settings = this.configs.use(BetaConfig)
			}
			export const examplePlugins = [
				{ plugin: AlphaPlugin, envBindings: [envBinding({config:{schema:AlphaConfig,mapping:{endpoint:'IMPORTED_ENDPOINT'}}})] },
				{ plugin: BetaPlugin },
			] as const
			export const BillingReference = { address() { throw new Error('Address references must not execute') } }
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
	it('combines disjoint config bindings while rejecting whole-input overlaps', async () => {
		const bindings = `[
			envBinding({config: {schema: AlphaConfig, mapping: {endpoint: 'APP_ENDPOINT'}}}),
			envBinding({config: {schema: AlphaConfig, mapping: {count: 'APP_COUNT'}}}),
		]`
		const facts = await parseFixture(staticEntry({ bindings }))
		expect(facts.targets.map((target) => target.path)).toEqual([['endpoint'], ['count']])
		await expect(
			parseFixture(
				staticEntry({ bindings: bindings.replace("{count: 'APP_COUNT'}", "'APP_CONFIG'") }),
			),
		).rejects.toThrow('duplicate environment target for Plugin AlphaPlugin')
	})

	it('resolves default and fork transport targets and scopes namespaces to Vault', async () => {
		const facts = await parseFixture(
			`
			import { defineHostApplication } from '@pluxel/host/application'
			import { envBinding as bind } from '@pluxel/host/bindings'
			import { AlphaPlugin, AlphaConfig, AlphaVault } from './plugins'
			export default defineHostApplication(() => ({
				plugins: [{
					plugin: AlphaPlugin,
					envBindings: [
						bind({config: {schema: AlphaConfig, mapping: {endpoint: 'DEFAULT_ENDPOINT'}}}),
						bind({vault: {namespace: 'account', schema: AlphaVault, mapping: {token: 'DEFAULT_TOKEN'}}}),
					],
					forks: {
						east: {envBindings: [bind({
							config: {schema: AlphaConfig, mapping: {endpoint: 'EAST_ENDPOINT'}},
							vault: {namespace: 'account', schema: AlphaVault, mapping: {token: 'EAST_TOKEN'}},
						})]},
					},
				}],
			}))
		`,
			true,
		)
		expect(facts.targets).toMatchObject([
			{ kind: 'config', environmentName: 'DEFAULT_ENDPOINT' },
			{ kind: 'vault', namespace: 'account', environmentName: 'DEFAULT_TOKEN' },
			{ kind: 'config', forkId: 'east', environmentName: 'EAST_ENDPOINT' },
			{ kind: 'vault', forkId: 'east', namespace: 'account', environmentName: 'EAST_TOKEN' },
		])
		expect(facts.targets[2]).not.toHaveProperty('namespace')
	})

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
			'must default-export defineHostApplication',
		)
		await expect(
			parseFixture(`
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			const base = { plugins: [] }
			export default defineHostApplication(() => ({ ...base, name: 'spread' }))
		`),
		).rejects.toThrow('does not allow spread properties')
		await expect(
			parseFixture(`
			import { defineHostApplication } from '@pluxel/host/application'
			export default defineHostApplication(() => ({}), {})
		`),
		).rejects.toThrow('requires one inline factory')
	})

	it('reads the platform-neutral application entry', async () => {
		const result = await parseFixture(`
			import { defineHostApplication } from '@pluxel/host/application'
			export default defineHostApplication(() => ({ name: 'shared', plugins: [] }))
		`)
		expect(result).toEqual({ name: 'shared', targets: [], hasSources: false })
	})

	it('reads an asynchronous factory without running preparation or nested callbacks', async () => {
		const result = await parseFixture(`
			import { defineHostApplication as application } from '@pluxel/host'
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
				`import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'; export default defineHostApplication(${factory})`,
			),
		).rejects.toThrow(/factory must/)
	})

	it('rejects conditional production catalogs without evaluating startup', async () => {
		await expect(
			parseFixture(
				`
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			import { AlphaPlugin, BetaPlugin } from './plugins'
			export default defineHostApplication((startup) => ({ plugins: startup.env.BETA ? [{plugin:BetaPlugin}] : [{plugin:AlphaPlugin}] }))
		`,
				true,
			),
		).rejects.toThrow('outside the static deployment contract')
	})

	it('does not mistake factory-local shadowing for the module catalog', async () => {
		await expect(
			parseFixture(
				`
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins } from './plugins'
			export default defineHostApplication(({ examplePlugins }) => ({ plugins: examplePlugins }))
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
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins as plugins } from './plugins'
			export default defineHostApplication(async (startup) => { ${preparation}; return {plugins} })
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
		`const addresses = plugins.map(({plugin}) => plugin.nodeAddress())`,
	])(
		'preserves module catalog identity across independent scopes and reads: %s',
		async (preparation) => {
			await expect(
				parseFixture(
					`
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins as plugins } from './plugins'
			export default defineHostApplication(() => { ${preparation}; return {plugins} })
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
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			import { examplePlugins as plugins } from './plugins'
			export default defineHostApplication(${factory})
		`,
				true,
			),
		).rejects.toThrow('outside the static deployment contract')
	})

	it('derives config and Vault transports from explicit schemas without reading bound files', async () => {
		const facts = await parseFixture(
			`
			import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
			import { AlphaPlugin, AlphaConfig, AlphaVault } from './plugins'
			export default defineHostApplication(() => ({
				plugins: [{
					plugin: AlphaPlugin,
					fileBindings: [fileBinding({config:{schema:AlphaConfig,path:'/must/not/read.json'}, vault:{schema:AlphaVault,paths:{token:'/must/not/read.secret'}}})],
					envBindings: [envBinding({config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'}}, vault:{namespace:'account-a',schema:AlphaVault,mapping:{token:'APP_TOKEN', account:{password:'APP_PASSWORD'}}}})],
				}],
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
			import { defineHostApplication, envBinding as bind } from '@pluxel/host'
			import { AlphaPlugin } from './plugins'
			import * as v from 'valibot'
			export default defineHostApplication(() => ({ plugins: [{plugin: AlphaPlugin, envBindings: [
				bind({config: {schema: v.object({name: v.string()}), mapping: {name: 'APP_NAME'}}})
			]}] }))
		`)
		expect(facts.targets[0]).toMatchObject({ environmentName: 'APP_NAME', path: ['name'] })
	})

	it.each([
		["[{plugin: AlphaPlugin, config:{endpoint:'APP_ENDPOINT'}}]", 'must call envBinding'],
		["[envBinding({config:{mapping:{endpoint:'APP_ENDPOINT'}}})]", 'requires schema and mapping'],
		[
			"[envBinding({config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'},extra:true}})]",
			'unknown config binding field',
		],
		[
			"[envBinding({vault:{schema:AlphaVault,mapping:'APP_VAULT'}})]",
			'must declare record keys directly',
		],
		[
			"[envBinding({vault:{schema:AlphaVault,mapping:{missing:'APP_TOKEN'}}})]",
			'is not declared by the Vault binding schema',
		],
		[
			"[envBinding({vault:{namespace:'constructor',schema:AlphaVault,mapping:{token:'APP_TOKEN'}}})]",
			'vault.namespace must be a valid Vault key',
		],
		[
			"[envBinding({vault:{schema:AlphaVault,mapping:{'to\\nken':'APP_TOKEN'}}})]",
			'vault.mapping record key must be a valid Vault key',
		],
		[
			`[
				envBinding({vault:{namespace:'account',schema:AlphaVault,mapping:{token:'FIRST'}}}),
				envBinding({vault:{namespace:'account',schema:AlphaVault,mapping:{token:'SECOND'}}}),
			]`,
			'duplicate environment target for Plugin AlphaPlugin',
		],
	])('rejects malformed explicit bindings: %s', async (bindings, message) => {
		await expect(parseFixture(staticEntry({ bindings }))).rejects.toThrow(message)
	})

	it('checks statically closed Vault record keys while retaining runtime fallbacks', async () => {
		const entry = (schema: string) =>
			staticEntry({
				extra: `import * as v from 'valibot'; const VaultSchema = v.record(${schema}, v.string())`,
				bindings: "[envBinding({vault:{schema:VaultSchema,mapping:{other:'APP_TOKEN'}}})]",
			})
		await expect(parseFixture(entry("v.picklist(['first', 'second'])"))).rejects.toThrow(
			'Vault binding key other is not declared',
		)
		const fallback = await parseFixture(
			entry("v.fallback(v.literal('first'), () => { throw new Error('must not execute') })"),
		)
		expect(fallback.targets).toMatchObject([{ environmentName: 'APP_TOKEN', path: ['other'] }])
	})

	it('rejects factory-local helpers that shadow the imported binding authority', async () => {
		await expect(
			parseFixture(`
			import { defineHostApplication, envBinding } from '@pluxel/host'
			import { AlphaPlugin, AlphaConfig } from './plugins'
			export default defineHostApplication((envBinding) => ({plugins:[{plugin:AlphaPlugin,envBindings:[
				envBinding({config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'}}})
			]}]}))
		`),
		).rejects.toThrow(
			'must call envBinding imported directly from @pluxel/host/bindings or @pluxel/host',
		)
	})

	it('preserves module schema identity when a factory shadows the schema import', async () => {
		await expect(
			parseFixture(`
			import { defineHostApplication, envBinding } from '@pluxel/host'
			import { AlphaPlugin, AlphaConfig } from './plugins'
			export default defineHostApplication((AlphaConfig) => ({plugins:[{plugin:AlphaPlugin,envBindings:[
				envBinding({config:{schema:AlphaConfig,mapping:{endpoint:'APP_ENDPOINT'}}})
			]}]}))
		`),
		).rejects.toThrow(/AlphaConfig/)
	})

	it('accepts explicit framework-prefixed names as ordinary declared bindings', async () => {
		const facts = await parseFixture(
			staticEntry({
				bindings:
					"[envBinding({ config: { schema: AlphaConfig, mapping: {endpoint:'PLUXEL_CUSTOM_ENDPOINT'} } })]",
			}),
		)
		expect(facts.environmentExample).toContain('# PLUXEL_CUSTOM_ENDPOINT=')
	})

	it('uses source resolution and raw-input projection to render deterministic fan-out', async () => {
		const code = staticEntry({
			declarations: `[
				{plugin: AlphaPlugin, envBindings: [envBinding({ config: { schema: AlphaConfig, mapping: {
					count: 'APP_COUNT',
					endpoint: 'APP_ENDPOINT',
				} } })]},
				{plugin: BetaPlugin, envBindings: [envBinding({ config: { schema: BetaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } })]},
			]`,
		})
		const first = await parseFixture(code)
		const second = await parseFixture(code)

		expect(first.environmentExample).toBe(second.environmentExample)
		expect(first.environmentExample).toBe(
			[
				'# Generated Pluxel config and Vault environment bindings.',
				'# Config values join declared input and follow the owner mode; Vault bindings are read-only.',
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

	it('reads an imported const declaration array and its bindings from their own scope', async () => {
		const facts = await parseFixture(staticEntry({ declarations: 'examplePlugins' }), true)
		expect(facts.plugins?.map(({ local }) => local)).toEqual(['AlphaPlugin', 'BetaPlugin'])
		expect(facts.targets).toHaveLength(1)
		expect(facts.environmentExample).toContain('# IMPORTED_ENDPOINT=')
	})

	it('uses the canonical source binding of an imported Plugin alias', async () => {
		const facts = await parseFixture(
			staticEntry({
				extra: `import { AlphaPlugin as ConfiguredAlpha } from './plugins'`,
				declarations: `[{plugin: ConfiguredAlpha, envBindings: [
					envBinding({ config: { schema: AlphaConfig, mapping: { endpoint: 'APP_ENDPOINT' } } })
				]}]`,
			}),
			true,
		)
		expect(facts.plugins?.map(({ local }) => local)).toEqual(['AlphaPlugin'])
		expect(facts.targets[0]?.pluginName).toBe('ConfiguredAlpha')
	})

	it('reports both positions when aliases repeat a fixed declaration', async () => {
		await expect(
			parseFixture(
				staticEntry({
					extra: `import { AlphaPlugin as ConfiguredAlpha } from './plugins'`,
					declarations: '[{plugin: AlphaPlugin}, {plugin: ConfiguredAlpha}]',
				}),
				true,
			),
		).rejects.toThrow(/plugins\[1\].*plugins\[0\]/)
	})

	it('projects bindings on an address-only declaration without loading its implementation', async () => {
		const facts = await parseFixture(`
			import { defineHostApplication, envBinding } from '@pluxel/host'
			import { BillingReference, AlphaConfig } from './plugins'
			export default defineHostApplication(startup => {
				const paths = startup.env.MANAGED_PATHS ?? []
				return {
					sources: paths.map(file => ({ file })),
					pluginNodes: [{
						definition: BillingReference.address(),
						forks: {
							east: {envBindings: [envBinding({config: {schema: AlphaConfig, mapping: {endpoint: 'BILLING_ENDPOINT'}}})]},
						},
					}],
				}
			})
		`)
		expect(facts.hasSources).toBe(true)
		expect(facts.plugins).toBeUndefined()
		expect(facts.targets).toMatchObject([
			{ pluginName: 'BillingReference', forkId: 'east', environmentName: 'BILLING_ENDPOINT' },
		])
	})

	it.each([
		{
			name: 'indirect array',
			code: staticEntry({
				extra: `const declarations = [envBinding({ config: { schema: AlphaConfig, mapping: 'APP_CONFIG' } })]`,
				bindings: 'declarations',
			}),
			message: 'must be a direct array literal',
		},
		{
			name: 'indirect bind',
			code: staticEntry({
				extra: `const declaration = envBinding({ config: { schema: AlphaConfig, mapping: 'APP_CONFIG' } })`,
				bindings: '[declaration]',
			}),
			message: 'must call envBinding imported directly from @pluxel/host/bindings or @pluxel/host',
		},
		{
			name: 'spread element',
			code: staticEntry({ bindings: '[...[]]' }),
			message: 'must call envBinding imported directly from @pluxel/host/bindings or @pluxel/host',
		},
		{
			name: 'indirect mapping',
			code: staticEntry({
				extra: `const mapping = { endpoint: 'APP_ENDPOINT' }`,
				bindings: '[envBinding({ config: { schema: AlphaConfig, mapping: mapping } })]',
			}),
			message: 'must be a direct environment name string or object literal',
		},
		{
			name: 'mapping spread',
			code: staticEntry({
				bindings:
					"[envBinding({ config: { schema: AlphaConfig, mapping: { ...{ endpoint: 'APP_ENDPOINT' } } } })]",
			}),
			message: 'does not allow spread properties',
		},
		{
			name: 'computed key',
			code: staticEntry({
				bindings:
					"[envBinding({ config: { schema: AlphaConfig, mapping: { ['endpoint']: 'APP_ENDPOINT' } } })]",
			}),
			message: 'must use a direct key',
		},
		{
			name: 'duplicate key',
			code: staticEntry({
				bindings:
					"[envBinding({ config: { schema: AlphaConfig, mapping: { endpoint: 'APP_A', endpoint: 'APP_B' } } })]",
			}),
			message: 'contains duplicate key "endpoint"',
		},
		{
			name: 'non-portable name',
			code: staticEntry({
				bindings:
					"[envBinding({ config: { schema: AlphaConfig, mapping: { endpoint: 'app-endpoint' } } })]",
			}),
			message: 'must match [A-Z_][A-Z0-9_]*',
		},
		{
			name: 'duplicate Plugin binding',
			code: staticEntry({
				bindings: `[
					envBinding({ config: { schema: AlphaConfig, mapping: { endpoint: 'APP_A' } } }),
					envBinding({ config: { schema: AlphaConfig, mapping: { endpoint: 'APP_B' } } }),
				]`,
			}),
			message: 'duplicate environment target for Plugin AlphaPlugin',
		},
		{
			name: 'bare constructor',
			code: staticEntry({ declarations: '[AlphaPlugin]' }),
			message: 'must be a direct declaration object',
		},
	])('rejects $name with one direct-declaration diagnostic', async ({ code, message }) => {
		await expect(parseFixture(code)).rejects.toThrow(message)
	})

	it('rejects conflicting fan-out transports and unsupported raw shapes', async () => {
		await expect(
			parseFixture(
				staticEntry({
					declarations: `[
						{plugin: AlphaPlugin, envBindings: [envBinding({ config: { schema: AlphaConfig, mapping: { count: 'APP_SHARED' } } })]},
						{plugin: BetaPlugin, envBindings: [envBinding({ config: { schema: BetaConfig, mapping: { endpoint: 'APP_SHARED' } } })]},
					]`,
				}),
			),
		).rejects.toThrow('conflicting derived transports number and string')

		await expect(
			parseFixture(
				staticEntry({
					declarations:
						"[{plugin: BetaPlugin, envBindings: [envBinding({ config: { schema: BetaConfig, mapping: { unknown: 'APP_UNKNOWN' } } })]}]",
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
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
				import { UnsafeConfig, UnsafePlugin } from './schema'
				export default defineHostApplication(() => ({
					name: 'unsafe',
					plugins: [{
						plugin: UnsafePlugin,
						envBindings: [envBinding({ config: { schema: UnsafeConfig, mapping: 'APP_CONFIG' } })],
					}],
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
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
				import { UnsafeConfig, UnsafePlugin } from './schema'
				export default defineHostApplication(() => ({
					name: 'unsafe-valibot-method',
					plugins: [{
						plugin: UnsafePlugin,
						envBindings: [envBinding({ config: { schema: UnsafeConfig, mapping: 'APP_CONFIG' } })],
					}],
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
