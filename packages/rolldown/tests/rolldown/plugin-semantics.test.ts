import { createFixture } from 'fs-fixture'
import { symlink } from 'node:fs/promises'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { createPluginSemanticsPlugin } from '../../src/rolldown/plugins/pluginSemanticsPlugin'

async function transformWithCollector(code: string, id = import.meta.filename) {
	const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
	const hook = collector.plugin.transform as {
		handler: (this: unknown, code: string, id: string) => unknown
	}
	const result = (await hook.handler.call(
		{
			error(message: string): never {
				throw new Error(message)
			},
			async resolve(): Promise<null> {
				return null
			},
		},
		code,
		id,
	)) as { code: string; map: null } | null
	return { collector, result }
}

async function transform(code: string, id = import.meta.filename) {
	const transformed = await transformWithCollector(code, id)
	return transformed.result
}

describe('plugin semantic lowering', () => {
	it('lowers nested PluginPart occurrences with required and optional edges', async () => {
		const result = await transform(`
			import type { AuditPlugin } from '@acme/audit'
			import { SearchPlugin } from '@acme/search'
			import { BasePlugin, definePluginRef, Plugin, PluginPart } from '@pluxel/runtime'
			const Audit = definePluginRef<AuditPlugin>()
			class LeafPart extends PluginPart<BranchPart> {
				constructor(readonly search: SearchPlugin) { super() }
				override init() { this.plugins.use(Audit, audit => void audit) }
			}
			class BranchPart extends PluginPart<OwnerPlugin> {
				readonly leaf = this.parts.use(LeafPart)
			}
			@Plugin() export class OwnerPlugin extends BasePlugin {
				readonly branch = this.parts.use(BranchPart)
			}
		`)

		expect(result?.code).toContain('__setPluginParts as __pluxelSetPluginParts')
		expect(result?.code).toContain(
			'__pluxelSetPluginParts(BranchPart, { abiVersion: 2, occurrences: [{ fieldName: "leaf", Part: LeafPart }] })',
		)
		expect(result?.code).toContain(
			'__pluxelSetPluginParts(OwnerPlugin, { abiVersion: 2, occurrences: [{ fieldName: "branch", Part: BranchPart }] })',
		)
		expect(result?.code).toContain(
			'__pluxelSetPluginPartOptional(LeafPart, {"abiVersion":2,"optional":[{"entry"',
		)
		expect(result?.code).toContain(
			'__pluxelSetPluginPartRequires(LeafPart, {"abiVersion":2,"requires":[{"entry":{"kind":"package-root","packageName":"@acme/search"},"exportName":"SearchPlugin"}]})',
		)
	})

	it('keeps mixed package-root imports distinct while required package metadata wins', async () => {
		const { collector, result } = await transformWithCollector(`
			import { MainPlugin as Main, SecondaryPlugin as Secondary, type AnotherPlugin as Another } from '@acme/multiple'
			import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'
			const OptionalAnother = definePluginRef<Another>()
			@Plugin({ displayName: 'Orders', startTimeoutMs: 5000 })
			export class OrdersPlugin extends BasePlugin {
				constructor(readonly main: Main, readonly secondary: Secondary) { super() }
				override init() {
					this.plugins.use(OptionalAnother, another => another.registerSource(this))
				}
			}
		`)
		const mainAddress = {
			entry: { kind: 'package-root', packageName: '@acme/multiple' },
			exportName: 'MainPlugin',
		} as const
		const secondaryAddress = {
			entry: { kind: 'package-root', packageName: '@acme/multiple' },
			exportName: 'SecondaryPlugin',
		} as const
		const anotherAddress = {
			entry: { kind: 'package-root', packageName: '@acme/multiple' },
			exportName: 'AnotherPlugin',
		} as const

		expect(result?.code).toContain('__setPluginDefinition as __pluxelSetPluginDefinition')
		expect(result?.code).toContain('__definePluginRef as __pluxelDefinePluginRef')
		expect(result?.code).toContain('from "@pluxel/runtime/toolchain"')
		expect(result?.code.split('// [pluxel-plugin-semantics] Injected facts')[1]).not.toMatch(
			/from ["']@pluxel\/runtime["']/,
		)
		expect(result?.code).toContain(
			'"kind":"source-entry","sourceSpace":"app","path":"plugin-semantics.test.ts"',
		)
		expect(result?.code).toContain('"exportName":"OrdersPlugin"')
		const orders = collector
			.definitions()
			.find((definition) => definition.className === 'OrdersPlugin')
		expect(orders?.requires).toEqual([mainAddress, secondaryAddress])
		expect(orders?.optional).toEqual([anotherAddress])
		expect(collector.snapshot()).toEqual(new Map([['@acme/multiple', 'required']]))
		expect(result?.code).toContain(
			'__pluxelDefinePluginRef({"abiVersion":2,"definition":{"entry":{"kind":"package-root","packageName":"@acme/multiple"},"exportName":"AnotherPlugin"}})',
		)
		expect(result?.code).not.toContain('optionalPlugin')
		expect(result?.code).not.toContain('PLUXEL_OPTIONAL_PLUGIN_ABSENT')
	})

	describe('optional Plugin ref authoring boundaries', () => {
		it.each([
			{
				name: 'runtime argument',
				code: `
					import type { AuditPlugin } from '@acme/audit'
					import { definePluginRef } from '@pluxel/runtime'
					const Audit = definePluginRef<AuditPlugin>({})
				`,
				message: 'with no runtime arguments',
			},
			{
				name: 'value-imported optional type',
				code: `
					import { AuditPlugin } from '@acme/audit'
					import { definePluginRef } from '@pluxel/runtime'
					const Audit = definePluginRef<AuditPlugin>()
				`,
				message: 'must use a direct type-only import',
			},
			{
				name: 'package subpath',
				code: `
					import type { AuditPlugin } from '@acme/audit/plugin'
					import { definePluginRef } from '@pluxel/runtime'
					const Audit = definePluginRef<AuditPlugin>()
				`,
				message: 'must come from package root',
			},
			{
				name: 'namespace-qualified type',
				code: `
					import type * as AuditPlugins from '@acme/audit'
					import { definePluginRef } from '@pluxel/runtime'
					const Audit = definePluginRef<AuditPlugins.AuditPlugin>()
				`,
				message: 'one simple Plugin type from a direct type-only named import',
			},
			{
				name: 'exported ref',
				code: `
					import type { AuditPlugin } from '@acme/audit'
					import { definePluginRef } from '@pluxel/runtime'
					export const Audit = definePluginRef<AuditPlugin>()
				`,
				message: 'must not be exported',
			},
			{
				name: 'inline ref',
				code: `
					import type { AuditPlugin } from '@acme/audit'
					import { definePluginRef } from '@pluxel/runtime'
					export function make() { return definePluginRef<AuditPlugin>() }
				`,
				message: 'module-level const',
			},
			{
				name: 'conditional use',
				code: `
					import type { AuditPlugin } from '@acme/audit'
					import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'
					const Audit = definePluginRef<AuditPlugin>()
					@Plugin() export class ConsumerPlugin extends BasePlugin {
						init() { if (true) this.plugins.use(Audit, audit => void audit) }
					}
				`,
				message: 'direct statement in init',
			},
			{
				name: 'async setup callback',
				code: `
					import type { AuditPlugin } from '@acme/audit'
					import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'
					const Audit = definePluginRef<AuditPlugin>()
					@Plugin() export class ConsumerPlugin extends BasePlugin {
						init() { this.plugins.use(Audit, async audit => void audit) }
					}
				`,
				message: 'callback must be synchronous',
			},
		])('rejects $name with actionable guidance', async ({ code, message }) => {
			await expect(transform(code)).rejects.toThrow(message)
		})
	})

	it('emits abstract provider facts and a concrete provides edge', async () => {
		const result = await transform(`
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			export abstract class Database extends BasePlugin {}
			@Plugin(Database)
			export class MemoryDatabasePlugin extends Database {}
		`)

		expect(result?.code).toContain(
			'__pluxelSetPluginDefinition(Database, {"abiVersion":2,"kind":"abstract"',
		)
		expect(result?.code).toContain(
			'"provides":{"entry":{"kind":"source-entry","sourceSpace":"app","path":"plugin-semantics.test.ts"},"exportName":"Database"}',
		)
	})

	it('uses one host-root-relative address across provider and cross-directory edges', async () => {
		await using fixture = await createFixture({
			'tests/plugins/Provider.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class Provider extends BasePlugin {}
			`,
			'tests/required/RequiredConsumer.ts': `
				import { Provider } from '../plugins/Provider'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class RequiredConsumer extends BasePlugin {
					constructor(readonly provider: Provider) { super() }
				}
			`,
			'tests/optional/OptionalConsumer.ts': `
				import type { Provider } from '../plugins/Provider'
				import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'
				const OptionalProvider = definePluginRef<Provider>()
				@Plugin() export class OptionalConsumer extends BasePlugin {
					init() { this.plugins.use(OptionalProvider, provider => void provider) }
				}
			`,
		})
		const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
		const build = await rolldown({
			input: {
				provider: fixture.getPath('tests/plugins/Provider.ts'),
				required: fixture.getPath('tests/required/RequiredConsumer.ts'),
				optional: fixture.getPath('tests/optional/OptionalConsumer.ts'),
			},
			external: ['@pluxel/runtime'],
			plugins: [collector.plugin],
		})
		await build.generate({ format: 'esm' })

		const definitions = new Map(
			collector.definitions().map((definition) => [definition.className, definition]),
		)
		const providerAddress = {
			entry: {
				kind: 'source-entry',
				sourceSpace: 'app',
				path: 'tests/plugins/Provider.ts',
			},
			exportName: 'Provider',
		} as const
		expect(definitions.get('Provider')?.definition).toEqual(providerAddress)
		expect(definitions.get('RequiredConsumer')?.requires).toEqual([providerAddress])
		expect(definitions.get('OptionalConsumer')?.optional).toEqual([providerAddress])
	})

	it('maps source-mode package root re-exports to package provenance', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@acme/cache',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			}),
			'src/backend.ts': `
				import { BasePlugin } from '@pluxel/runtime'
				export abstract class CacheBackend extends BasePlugin {}
			`,
			'src/index.ts': `
				import { CacheBackend } from './backend'
				import { Plugin } from '@pluxel/runtime'
				export { CacheBackend } from './backend'
				@Plugin(CacheBackend) export class MemoryCacheBackendPlugin extends CacheBackend {}
			`,
			'tests/TestCacheBackend.ts': `
				import { CacheBackend } from '../src/index'
				import { Plugin } from '@pluxel/runtime'
				@Plugin(CacheBackend) export class TestCacheBackend extends CacheBackend {}
			`,
		})
		const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
		const build = await rolldown({
			input: fixture.getPath('tests/TestCacheBackend.ts'),
			external: ['@pluxel/runtime'],
			plugins: [collector.plugin],
		})
		await build.generate({ format: 'esm' })

		const definitions = new Map(
			collector.definitions().map((definition) => [definition.className, definition]),
		)
		const tokenAddress = {
			entry: { kind: 'package-root', packageName: '@acme/cache' },
			exportName: 'CacheBackend',
		} as const
		expect(definitions.get('CacheBackend')?.definition).toEqual(tokenAddress)
		expect(definitions.get('MemoryCacheBackendPlugin')?.provides).toEqual(tokenAddress)
		expect(definitions.get('TestCacheBackend')?.definition).toEqual({
			entry: {
				kind: 'source-entry',
				sourceSpace: 'app',
				path: 'tests/TestCacheBackend.ts',
			},
			exportName: 'TestCacheBackend',
		})
		expect(definitions.get('TestCacheBackend')?.provides).toEqual(tokenAddress)
	})

	it('rejects absolute source identities outside a static application root', async () => {
		await using fixture = await createFixture({
			'host/package.json': JSON.stringify({ name: '@acme/host', type: 'module' }),
			'plugins/orders/package.json': JSON.stringify({
				name: '@acme/orders',
				type: 'module',
				exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
			}),
			'plugins/orders/src/index.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class OrdersPlugin extends BasePlugin {}
			`,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath('host'),
		})

		await expect(
			rolldown({
				input: fixture.getPath('plugins/orders/src/index.ts'),
				external: ['@pluxel/runtime'],
				plugins: [collector.plugin],
			}).then((build) => build.generate({ format: 'esm' })),
		).rejects.toThrow('outside configured source spaces')
	})

	it('selects the most specific configured source space', async () => {
		await using fixture = await createFixture({
			'host/plugins/managed/orders.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class OrdersPlugin extends BasePlugin {}
			`,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath('host'),
			sourceSpaces: [{ name: 'managed', root: 'plugins/managed' }],
		})
		const build = await rolldown({
			input: fixture.getPath('host/plugins/managed/orders.ts'),
			external: ['@pluxel/runtime'],
			plugins: [collector.plugin],
		})
		await build.generate({ format: 'esm' })

		expect(collector.definitions()[0]?.definition).toEqual({
			entry: { kind: 'source-entry', sourceSpace: 'managed', path: 'orders.ts' },
			exportName: 'OrdersPlugin',
		})
	})

	it('keeps a symlinked source-space root under its logical name', async () => {
		await using fixture = await createFixture({
			'host/.keep': '',
			'physical/orders.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class OrdersPlugin extends BasePlugin {}
			`,
		})
		await symlink(
			fixture.getPath('physical'),
			fixture.getPath('host/managed'),
			process.platform === 'win32' ? 'junction' : 'dir',
		)
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath('host'),
			sourceSpaces: [{ name: 'managed', root: 'managed' }],
		})
		const build = await rolldown({
			input: fixture.getPath('host/managed/orders.ts'),
			external: ['@pluxel/runtime'],
			plugins: [collector.plugin],
		})
		await build.generate({ format: 'esm' })

		expect(collector.definitions()[0]?.definition).toEqual({
			entry: { kind: 'source-entry', sourceSpace: 'managed', path: 'orders.ts' },
			exportName: 'OrdersPlugin',
		})
	})

	it('rejects a source-space file symlink that escapes after realpath', async () => {
		await using fixture = await createFixture({
			'host/plugins/.keep': '',
			'outside/orders.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class OrdersPlugin extends BasePlugin {}
			`,
		})
		await symlink(
			fixture.getPath('outside/orders.ts'),
			fixture.getPath('host/plugins/orders.ts'),
			'file',
		)
		const collector = createPluginSemanticsPlugin({ root: fixture.getPath('host') })

		await expect(
			rolldown({
				input: fixture.getPath('host/plugins/orders.ts'),
				external: ['@pluxel/runtime'],
				plugins: [collector.plugin],
			}).then((build) => build.generate({ format: 'esm' })),
		).rejects.toThrow('outside configured source spaces')
	})

	it.each(['@pluxel/core/test', '@pluxel/runtime/test', '@pluxel/test'])(
		'recognizes the formal test authoring facade %s',
		async (source) => {
			const result = await transform(`
				import { BasePlugin, Plugin } from '${source}'
				@Plugin({ displayName: 'Test Plugin' })
				export class TestPlugin extends BasePlugin {}
			`)
			expect(result?.code).toContain('__pluxelSetPluginDefinition(TestPlugin')
		},
	)

	it('accepts literal concrete forkability and uses only the versioned toolchain entry', async () => {
		const result = await transform(`
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			@Plugin({ forkable: true })
			export class CachePlugin extends BasePlugin {}
		`)

		expect(result?.code).toContain('"abiVersion":2')
		expect(result?.code).toContain('from "@pluxel/runtime/toolchain"')
		expect(result?.code.split('// [pluxel-plugin-semantics] Injected facts')[1]).not.toMatch(
			/from ["']@pluxel\/runtime["']/,
		)
	})

	it('rejects a semantic helper root alias', () => {
		expect(() =>
			createPluginSemanticsPlugin({ helperImportSource: '@pluxel/runtime' as never }),
		).toThrow('/toolchain subpath')
	})

	it.each([
		{
			name: 'abstract PluginPart',
			code: `
				import { PluginPart } from '@pluxel/runtime'
				abstract class BadPart extends PluginPart {}
			`,
			message: 'must be concrete',
		},
		{
			name: 'marked PluginPart',
			code: `
				import { Plugin, PluginPart } from '@pluxel/runtime'
				@Plugin() class BadPart extends PluginPart {}
			`,
			message: 'must not use @Plugin',
		},
		{
			name: 'local Part containment cycle',
			code: `
				import { BasePlugin, Plugin, PluginPart } from '@pluxel/runtime'
				class FirstPart extends PluginPart { second = this.parts.use(SecondPart) }
				class SecondPart extends PluginPart { first = this.parts.use(FirstPart) }
				@Plugin() class Owner extends BasePlugin { first = this.parts.use(FirstPart) }
			`,
			message: 'containment cycle',
		},
		{
			name: 'dynamic Part occurrence',
			code: `
				import { BasePlugin, Plugin, PluginPart } from '@pluxel/runtime'
				class ChildPart extends PluginPart {}
				@Plugin() class Owner extends BasePlugin {
					make() { return this.parts.use(ChildPart) }
				}
			`,
			message: 'complete initializer of a normal class field',
		},
		{
			name: 'type-only Part occurrence',
			code: `
				import type { RemotePart } from './part'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() class Owner extends BasePlugin {
					readonly child = this.parts.use(RemotePart)
				}
			`,
			message: 'must use a value import',
		},
		{
			name: 'type-only required dependency',
			code: `
				import type { DatabasePlugin } from '@acme/database'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					constructor(readonly database: DatabasePlugin) { super() }
				}
			`,
			message: 'must use a value import',
		},
		{
			name: 'type-only PluginPart required dependency',
			code: `
				import type { DatabasePlugin } from '@acme/database'
				import { PluginPart } from '@pluxel/runtime'
				class ConsumerPart extends PluginPart {
					constructor(readonly database: DatabasePlugin) { super() }
				}
			`,
			message: 'must use a value import',
		},
		{
			name: 'optional PluginPart constructor parameter',
			code: `
				import { DatabasePlugin } from '@acme/database'
				import { PluginPart } from '@pluxel/runtime'
				class ConsumerPart extends PluginPart {
					constructor(readonly database: DatabasePlugin | undefined) { super() }
				}
			`,
			message: 'must be simple Plugin type references',
		},
		{
			name: 'duplicate required dependency definition',
			code: `
				import { DatabasePlugin } from '@acme/database'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					constructor(readonly primary: DatabasePlugin, readonly replica: DatabasePlugin) { super() }
				}
			`,
			message: 'plugin_dependency_requirement_duplicate',
		},
		{
			name: 'duplicate PluginPart required dependency definition',
			code: `
				import { DatabasePlugin } from '@acme/database'
				import { PluginPart } from '@pluxel/runtime'
				class ConsumerPart extends PluginPart {
					constructor(readonly primary: DatabasePlugin, readonly replica: DatabasePlugin) { super() }
				}
			`,
			message: 'plugin_dependency_requirement_duplicate',
		},
		{
			name: 'package subpath dependency',
			code: `
				import { DatabasePlugin } from '@acme/database/backend'
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					constructor(readonly database: DatabasePlugin) { super() }
				}
			`,
			message: 'must come from package root',
		},
		{
			name: 'PluginPart package subpath dependency',
			code: `
				import { DatabasePlugin } from '@acme/database/backend'
				import { PluginPart } from '@pluxel/runtime'
				class ConsumerPart extends PluginPart {
					constructor(readonly database: DatabasePlugin) { super() }
				}
			`,
			message: 'must come from package root',
		},
		{
			name: 'false forkability',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin({ forkable: false }) export class ConsumerPlugin extends BasePlugin {}
			`,
			message: 'forkable must be the literal true',
		},
		{
			name: 'dynamic forkability',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				const enabled = true
				@Plugin({ forkable: enabled }) export class ConsumerPlugin extends BasePlugin {}
			`,
			message: 'forkable must be the literal true',
		},
		{
			name: 'native private Plugin state',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin { #state = 1 }
			`,
			message: 'plugin_caller_view_private_brand_unsupported',
		},
		{
			name: 'arrow-function Plugin field',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					status = () => this.ctx.caller
				}
			`,
			message: 'plugin_caller_view_callable_field_unsupported',
		},
		{
			name: 'function-expression Plugin field',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					status = function () { return this.ctx.caller }
				}
			`,
			message: 'plugin_caller_view_callable_field_unsupported',
		},
		{
			name: 'bound Plugin method field',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					status() { return this.ctx.caller }
					boundStatus = this.status.bind(this)
				}
			`,
			message: 'plugin_caller_view_callable_field_unsupported',
		},
		{
			name: 'type-only declared Plugin field',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class ConsumerPlugin extends BasePlugin {
					declare status: string
				}
			`,
			message: 'plugin_caller_view_declared_field_unsupported',
		},
		{
			name: 'callable field in local Plugin base',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				abstract class ConsumerBase extends BasePlugin {
					status = () => this.ctx.caller
				}
				@Plugin() export class ConsumerPlugin extends ConsumerBase {}
			`,
			message: 'plugin_caller_view_callable_field_unsupported',
		},
		{
			name: 'native private state in local Plugin base',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				abstract class ConsumerBase extends BasePlugin { #read() {} }
				@Plugin() export class ConsumerPlugin extends ConsumerBase {}
			`,
			message: 'plugin_caller_view_private_brand_unsupported',
		},
		{
			name: 'legacy marker option',
			code: `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin({ name: 'Legacy' }) export class ConsumerPlugin extends BasePlugin {}
			`,
			message: 'unsupported @Plugin option',
		},
	])('rejects $name', async ({ code, message }) => {
		await expect(transform(code)).rejects.toThrow(message)
	})

	it('validates package-root uniqueness and plugin-free subpaths before bundling', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@acme/orders',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
					'./worker': { '@pluxel/hmr': './src/worker.ts', default: './dist/worker.mjs' },
				},
			}),
			'src/index.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class OrdersPlugin extends BasePlugin {}
			`,
			'src/worker.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class WorkerPlugin extends BasePlugin {}
			`,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath(),
			packageJsonPath: fixture.getPath('package.json'),
		})

		await expect(
			rolldown({
				input: fixture.getPath('src/index.ts'),
				external: ['@pluxel/runtime'],
				plugins: [collector.plugin],
			}).then((build) => build.generate({ format: 'esm' })),
		).rejects.toThrow('is plugin-bearing')
	})

	it('collects package metadata only from owner-reachable local Parts across modules', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@acme/orders',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			}),
			'src/index.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				import { UsedPart } from './parts'
				@Plugin() export class OrdersPlugin extends BasePlugin {
					readonly used = this.parts.use(UsedPart)
				}
			`,
			'src/parts.ts': `
				export * from './used'
				export * from './unused'
			`,
			'src/used.ts': `
				import { UsedProvider } from '@acme/used'
				import { PluginPart } from '@pluxel/runtime'
				export class UsedPart extends PluginPart {
					constructor(readonly provider: UsedProvider) { super() }
				}
			`,
			'src/unused.ts': `
				import { UnusedProvider } from '@acme/unused'
				import { PluginPart } from '@pluxel/runtime'
				export class UnusedPart extends PluginPart {
					constructor(readonly provider: UnusedProvider) { super() }
				}
			`,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath(),
			packageJsonPath: fixture.getPath('package.json'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime', '@acme/used', '@acme/unused'],
			plugins: [collector.plugin],
		})
		await build.generate({ format: 'esm' })

		expect(collector.snapshot()).toEqual(new Map([['@acme/used', 'required']]))
	})

	it.each([
		{
			name: 'ordinary class',
			parts: 'export class UsedPart {}',
			message: 'must resolve to one direct PluginPart subclass',
		},
		{
			name: 'inherited Part',
			parts: `
				import { PluginPart } from '@pluxel/runtime'
				class BasePart extends PluginPart {}
				export class UsedPart extends BasePart {}
			`,
			message: 'must resolve to one direct PluginPart subclass',
		},
		{
			name: 'ambiguous export-star Part',
			parts: "export * from './first'; export * from './second'",
			extra: {
				'src/first.ts': `
					import { PluginPart } from '@pluxel/runtime'
					export class UsedPart extends PluginPart {}
				`,
				'src/second.ts': `
					import { PluginPart } from '@pluxel/runtime'
					export class UsedPart extends PluginPart {}
				`,
			},
			message: 'is ambiguous across local export-star branches',
		},
	])('rejects an imported $name as a Part target', async ({ parts, extra, message }) => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@acme/orders',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			}),
			'src/index.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				import { UsedPart } from './parts'
				@Plugin() export class OrdersPlugin extends BasePlugin {
					private readonly used = this.parts.use(UsedPart)
				}
			`,
			'src/parts.ts': parts,
			...extra,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath(),
			packageJsonPath: fixture.getPath('package.json'),
		})

		await expect(
			rolldown({
				input: fixture.getPath('src/index.ts'),
				external: ['@pluxel/runtime'],
				plugins: [collector.plugin],
			}).then((build) => build.generate({ format: 'esm' })),
		).rejects.toThrow(message)
	})

	it('assigns distinct package-root identities to different Plugin constructors', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@acme/multiple',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			}),
			'src/index.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class MainPlugin extends BasePlugin {}
				@Plugin() export class AnotherPlugin extends BasePlugin {}
			`,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath(),
			packageJsonPath: fixture.getPath('package.json'),
		})
		const build = await rolldown({
			input: fixture.getPath('src/index.ts'),
			external: ['@pluxel/runtime'],
			plugins: [collector.plugin],
		})
		await build.generate({ format: 'esm' })

		const definitions = new Map(
			collector.definitions().map(({ className, definition }) => [className, definition]),
		)
		expect(definitions.size).toBe(2)
		expect(definitions.get('MainPlugin')).toEqual({
			entry: { kind: 'package-root', packageName: '@acme/multiple' },
			exportName: 'MainPlugin',
		})
		expect(definitions.get('AnotherPlugin')).toEqual({
			entry: { kind: 'package-root', packageName: '@acme/multiple' },
			exportName: 'AnotherPlugin',
		})
	})

	it('rejects one constructor exported by two package-root names', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@acme/orders',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
				},
			}),
			'src/index.ts': `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() class OrdersPlugin extends BasePlugin {}
				export { OrdersPlugin, OrdersPlugin as AliasPlugin }
			`,
		})
		const collector = createPluginSemanticsPlugin({
			root: fixture.getPath(),
			packageJsonPath: fixture.getPath('package.json'),
		})

		await expect(
			rolldown({
				input: fixture.getPath('src/index.ts'),
				external: ['@pluxel/runtime'],
				plugins: [collector.plugin],
			}).then((build) => build.generate({ format: 'esm' })),
		).rejects.toThrow('multiple root names')
	})
})
