import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { createConfigSchemaSourceResolver } from '../../src/rolldown/plugins/configSourcePlugin'
import { parseStaticRuntimeDeclaration } from '../../src/rolldown/plugins/staticConfigEnvironment'
import { parseStandaloneWithLang } from '../../src/rolldown/plugins/pluginUtils'

function staticEntry(options: { bootstrap: string; plugins?: string; extra?: string }): string {
	return `
		import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
		import { AlphaConfig, AlphaPlugin, BetaConfig, BetaPlugin, examplePlugins } from './plugins'
		${options.extra ?? ''}
		export default defineStaticRuntime({
			name: 'fixture',
			plugins: ${options.plugins ?? '[AlphaPlugin, BetaPlugin]'},
			configEnvironmentBootstrap: ${options.bootstrap},
		})
	`
}

async function parseFixture(code: string) {
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
			import { AlphaConfig, BetaConfig } from './schemas'
			export * from './schemas'
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
	it('does not narrow legacy static entry shapes when bootstrap is omitted', async () => {
		const indirect = await parseFixture(`
			import { defineStaticRuntime } from '@pluxel/runtime-static'
			const application = { name: 'indirect', plugins: [] }
			export default defineStaticRuntime(application)
		`)
		const spread = await parseFixture(`
			import { defineStaticRuntime } from '@pluxel/runtime-static'
			const base = { plugins: [] }
			export default defineStaticRuntime({ ...base, name: 'spread' })
		`)

		expect(indirect).toEqual({ targets: [] })
		expect(spread).toEqual({ name: 'spread', targets: [] })
	})

	it('uses source resolution and raw-input projection to render deterministic fan-out', async () => {
		const code = staticEntry({
			bootstrap: `[
				bindConfigEnvironment(AlphaPlugin, AlphaConfig, {
					count: 'APP_COUNT',
					endpoint: 'APP_ENDPOINT',
				}),
				bindConfigEnvironment(BetaPlugin, BetaConfig, { endpoint: 'APP_ENDPOINT' }),
			]`,
		})
		const first = await parseFixture(code)
		const second = await parseFixture(code)

		expect(first.environmentExample).toBe(second.environmentExample)
		expect(first.environmentExample).toBe(
			[
				'# Generated Pluxel static config bootstrap variables.',
				'# Existing persisted config remains authoritative.',
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
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'APP_ENDPOINT' })]",
			}),
		)
		expect(facts.targets).toHaveLength(1)
		expect(facts.environmentExample).toContain('# APP_ENDPOINT=')
	})

	it('accepts an imported Plugin alias by canonical source binding identity', async () => {
		const facts = await parseFixture(
			staticEntry({
				extra: `import { AlphaPlugin as ConfiguredAlpha } from './plugins'`,
				plugins: 'examplePlugins',
				bootstrap:
					"[bindConfigEnvironment(ConfiguredAlpha, AlphaConfig, { endpoint: 'APP_ENDPOINT' })]",
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
					bootstrap:
						"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'APP_ENDPOINT' })]",
				}),
			),
		).rejects.toThrow('is not present in the statically resolved plugins catalog')
	})

	it.each([
		{
			name: 'indirect array',
			code: staticEntry({
				extra: `const declarations = [bindConfigEnvironment(AlphaPlugin, AlphaConfig, 'APP_CONFIG')]`,
				bootstrap: 'declarations',
			}),
			message: 'must be a direct array literal',
		},
		{
			name: 'indirect bind',
			code: staticEntry({
				extra: `const declaration = bindConfigEnvironment(AlphaPlugin, AlphaConfig, 'APP_CONFIG')`,
				bootstrap: '[declaration]',
			}),
			message: 'must be a direct bindConfigEnvironment() call',
		},
		{
			name: 'spread element',
			code: staticEntry({ bootstrap: '[...[]]' }),
			message: 'must be a direct bindConfigEnvironment() call',
		},
		{
			name: 'indirect mapping',
			code: staticEntry({
				extra: `const mapping = { endpoint: 'APP_ENDPOINT' }`,
				bootstrap: '[bindConfigEnvironment(AlphaPlugin, AlphaConfig, mapping)]',
			}),
			message: 'must be a direct environment name string or object literal',
		},
		{
			name: 'mapping spread',
			code: staticEntry({
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { ...{ endpoint: 'APP_ENDPOINT' } })]",
			}),
			message: 'does not allow spread properties',
		},
		{
			name: 'computed key',
			code: staticEntry({
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { ['endpoint']: 'APP_ENDPOINT' })]",
			}),
			message: 'must use a direct key',
		},
		{
			name: 'duplicate key',
			code: staticEntry({
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'APP_A', endpoint: 'APP_B' })]",
			}),
			message: 'contains duplicate key "endpoint"',
		},
		{
			name: 'non-portable name',
			code: staticEntry({
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'app-endpoint' })]",
			}),
			message: 'must match [A-Z_][A-Z0-9_]*',
		},
		{
			name: 'reserved name',
			code: staticEntry({
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'PLUXEL_CONFIG' })]",
			}),
			message: 'is reserved for the Pluxel framework',
		},
		{
			name: 'duplicate Plugin binding',
			code: staticEntry({
				bootstrap: `[
					bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'APP_A' }),
					bindConfigEnvironment(AlphaPlugin, AlphaConfig, { count: 'APP_B' }),
				]`,
			}),
			message: 'duplicate config environment bindings for Plugin AlphaPlugin',
		},
		{
			name: 'wrong Plugin schema',
			code: staticEntry({
				bootstrap: "[bindConfigEnvironment(AlphaPlugin, BetaConfig, { endpoint: 'APP_ENDPOINT' })]",
			}),
			message: 'does not match the root config schema declared by Plugin AlphaPlugin',
		},
		{
			name: 'unknown catalog Plugin',
			code: staticEntry({
				plugins: '[BetaPlugin]',
				bootstrap:
					"[bindConfigEnvironment(AlphaPlugin, AlphaConfig, { endpoint: 'APP_ENDPOINT' })]",
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
					bootstrap: `[
						bindConfigEnvironment(AlphaPlugin, AlphaConfig, { count: 'APP_SHARED' }),
						bindConfigEnvironment(BetaPlugin, BetaConfig, { endpoint: 'APP_SHARED' }),
					]`,
				}),
			),
		).rejects.toThrow('conflicting derived transports number and string')

		await expect(
			parseFixture(
				staticEntry({
					bootstrap: "[bindConfigEnvironment(BetaPlugin, BetaConfig, { unknown: 'APP_UNKNOWN' })]",
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
				import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
				import { UnsafeConfig, UnsafePlugin } from './schema'
				export default defineStaticRuntime({
					name: 'unsafe',
					plugins: [UnsafePlugin],
					configEnvironmentBootstrap: [bindConfigEnvironment(UnsafePlugin, UnsafeConfig, 'APP_CONFIG')],
				})
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
				import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
				import { UnsafeConfig, UnsafePlugin } from './schema'
				export default defineStaticRuntime({
					name: 'unsafe-valibot-method',
					plugins: [UnsafePlugin],
					configEnvironmentBootstrap: [bindConfigEnvironment(UnsafePlugin, UnsafeConfig, 'APP_CONFIG')],
				})
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
