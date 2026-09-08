import { createFixture } from 'fs-fixture'
import { symlink, writeFile } from 'node:fs/promises'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { createPluginSemanticsPlugin } from '../../src/rolldown/plugins/pluginSemanticsPlugin'

async function transformWithExistingCollector(
	collector: ReturnType<typeof createPluginSemanticsPlugin>,
	code: string,
	id = import.meta.filename,
	resolveImport: (source: string) => Promise<{ id: string } | null> = async () => null,
) {
	const hook = collector.plugin.transform as {
		handler: (this: unknown, code: string, id: string) => unknown
	}
	const result = (await hook.handler.call(
		{
			error(message: string): never {
				throw new Error(message)
			},
			resolve: resolveImport,
		},
		code,
		id,
	)) as { code: string; map: null } | null
	return result
}

async function transformWithCollector(code: string, id = import.meta.filename) {
	const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
	const result = await transformWithExistingCollector(collector, code, id)
	return { collector, result }
}

async function transform(code: string, id = import.meta.filename) {
	const transformed = await transformWithCollector(code, id)
	return transformed.result
}

function preloweredDefinitionSource(
	definition: object,
	options: { abiVersion?: number; toolchain?: string } = {},
): string {
	return `import{__setPluginDefinition as s}from${JSON.stringify(options.toolchain ?? '@pluxel/runtime/toolchain')};class BuiltPlugin{}s(BuiltPlugin,${JSON.stringify(
		{
			abiVersion: options.abiVersion ?? 2,
			kind: 'plugin',
			definition,
			constructorRequires: [],
			optional: [],
		},
	)});`
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

	it('replaces raw-source facts atomically and filters them by the active module closure', async () => {
		const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
		const moduleId = import.meta.filename
		const inactiveModuleId = new URL('./plugins.test.ts', import.meta.url).pathname

		await transformWithExistingCollector(
			collector,
			`
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class FirstPlugin extends BasePlugin {}
			`,
			`${moduleId}?generation=1`,
		)
		const first = collector.definitions()[0]!.definition
		expect(collector.classifyDefinitionArtifact(first)).toBe('source-module')
		expect(collector.classifyDefinitionArtifact(first, [`${moduleId}?active=1`])).toBe(
			'source-module',
		)
		expect(collector.classifyDefinitionArtifact(first, [inactiveModuleId])).toBe('unreported')

		await transformWithExistingCollector(
			collector,
			`
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class SecondPlugin extends BasePlugin {}
			`,
			`${moduleId}?generation=2`,
		)
		const definitions = collector.definitions()
		expect(definitions).toHaveLength(1)
		expect(definitions[0]?.className).toBe('SecondPlugin')
		expect(collector.classifyDefinitionArtifact(first)).toBe('unreported')
		expect(collector.classifyDefinitionArtifact(definitions[0]!.definition, [moduleId])).toBe(
			'source-module',
		)
	})

	it('reports built modules only from exact pre-lowered definition facts', async () => {
		const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
		const source = `
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			@Plugin() export class TrackedPlugin extends BasePlugin {}
		`
		await transformWithExistingCollector(collector, source)
		const definition = collector.definitions()[0]!.definition

		await transformWithExistingCollector(collector, 'export const ordinary = true')
		expect(collector.classifyDefinitionArtifact(definition)).toBe('unreported')

		await transformWithExistingCollector(collector, source)
		await transformWithExistingCollector(collector, preloweredDefinitionSource(definition))
		expect(collector.classifyDefinitionArtifact(definition)).toBe('unreported')
		expect(collector.classifyDefinitionArtifact(definition, [import.meta.filename])).toBe(
			'built-module',
		)
		expect(collector.definitions()).toEqual([])
		await transformWithExistingCollector(
			collector,
			`export * from '@acme/installed-plugin'
			import * as pluginModule from '@acme/installed-plugin'
			export default pluginModule.default`,
		)
		expect(collector.classifyDefinitionArtifact(definition, [import.meta.filename])).toBe(
			'unreported',
		)

		const lookalikeModule = `${import.meta.filename}.mjs`
		await transformWithExistingCollector(
			collector,
			`const __setPluginDefinition = () => undefined
			__setPluginDefinition(null, ${JSON.stringify({ definition })})`,
			lookalikeModule,
		)
		expect(collector.classifyDefinitionArtifact(definition, [lookalikeModule])).toBe('unreported')

		await transformWithExistingCollector(
			collector,
			preloweredDefinitionSource(definition, { abiVersion: 1 }),
		)
		expect(collector.classifyDefinitionArtifact(definition)).toBe('unreported')

		await transformWithExistingCollector(
			collector,
			preloweredDefinitionSource(definition, { toolchain: '@acme/fake-toolchain' }),
		)
		expect(collector.classifyDefinitionArtifact(definition)).toBe('unreported')

		await transformWithExistingCollector(collector, source)
		const watchChange = collector.plugin.watchChange as (
			id: string,
			change: { event: 'delete' },
		) => void
		watchChange(import.meta.filename, { event: 'delete' })
		expect(collector.classifyDefinitionArtifact(definition)).toBe('unreported')
	})

	it('uses the active closure to disambiguate the same source and built definition', async () => {
		const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
		const sourceModule = import.meta.filename
		const builtModule = new URL('./plugins.test.ts', import.meta.url).pathname
		await transformWithExistingCollector(
			collector,
			`
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				@Plugin() export class SharedPlugin extends BasePlugin {}
			`,
			sourceModule,
		)
		const definition = collector.definitions()[0]!.definition
		await transformWithExistingCollector(
			collector,
			preloweredDefinitionSource(definition),
			builtModule,
		)

		expect(collector.classifyDefinitionArtifact(definition)).toBe('unreported')
		expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('source-module')
		expect(collector.classifyDefinitionArtifact(definition, [`${builtModule}?v=2`])).toBe(
			'built-module',
		)
		expect(collector.classifyDefinitionArtifact(definition, ['/tmp/unrelated.mjs'])).toBe(
			'unreported',
		)
	})

	it('rolls back or commits one artifact fact generation atomically', async () => {
		const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
		const sourceModule = import.meta.filename
		const builtModule = new URL('./plugins.test.ts', import.meta.url).pathname
		const source = `
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			@Plugin() export class TransactionPlugin extends BasePlugin {}
		`
		await transformWithExistingCollector(collector, source, sourceModule)
		const definition = collector.definitions()[0]!.definition
		await transformWithExistingCollector(
			collector,
			preloweredDefinitionSource(definition),
			builtModule,
		)

		const rolledBack = collector.beginArtifactGeneration()
		expect(() => collector.beginArtifactGeneration()).toThrow('already active')
		await rolledBack.run(async () => {
			await transformWithExistingCollector(collector, 'export const ordinary = true', sourceModule)
			await transformWithExistingCollector(collector, 'export const ordinary = true', builtModule)
			expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('unreported')
			expect(collector.classifyDefinitionArtifact(definition, [builtModule])).toBe('unreported')
		})
		expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('source-module')
		expect(collector.classifyDefinitionArtifact(definition, [builtModule])).toBe('built-module')
		rolledBack.rollback()
		rolledBack.rollback()
		expect((): void => {
			rolledBack.run((): void => undefined)
		}).toThrow('already settled')
		expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('source-module')
		expect(collector.classifyDefinitionArtifact(definition, [builtModule])).toBe('built-module')

		const committed = collector.beginArtifactGeneration()
		await committed.run(() =>
			transformWithExistingCollector(collector, 'export const ordinary = true', builtModule),
		)
		committed.commit()
		committed.commit()
		expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('source-module')
		expect(collector.classifyDefinitionArtifact(definition, [builtModule])).toBe('unreported')
	})

	it('isolates concurrent ambient artifact mutations and never overwrites a newer same-key fact', async () => {
		const collector = createPluginSemanticsPlugin({ root: import.meta.dirname })
		const sourceModule = import.meta.filename
		const builtModule = new URL('./plugins.test.ts', import.meta.url).pathname
		const source = `
			import { BasePlugin, Plugin } from '@pluxel/runtime'
			@Plugin() export class ConcurrentPlugin extends BasePlugin {}
		`
		await transformWithExistingCollector(collector, source, sourceModule)
		const definition = collector.definitions()[0]!.definition
		await transformWithExistingCollector(
			collector,
			preloweredDefinitionSource(definition),
			builtModule,
		)
		const watchChange = collector.plugin.watchChange as (
			id: string,
			change: { event: 'delete' },
		) => void

		const rollbackReady = Promise.withResolvers<void>()
		const resumeRollback = Promise.withResolvers<void>()
		const rolledBack = collector.beginArtifactGeneration()
		const rollbackWork = rolledBack.run(async () => {
			await transformWithExistingCollector(collector, 'export const candidate = true', sourceModule)
			rollbackReady.resolve()
			await resumeRollback.promise
			expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('unreported')
			expect(collector.classifyDefinitionArtifact(definition, [builtModule])).toBe('built-module')
		})
		await rollbackReady.promise
		watchChange(builtModule, { event: 'delete' })
		resumeRollback.resolve()
		await rollbackWork
		rolledBack.rollback()
		expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('source-module')
		expect(collector.classifyDefinitionArtifact(definition, [builtModule])).toBe('unreported')

		const commitReady = Promise.withResolvers<void>()
		const resumeCommit = Promise.withResolvers<void>()
		const committed = collector.beginArtifactGeneration()
		const commitWork = committed.run(async () => {
			await transformWithExistingCollector(collector, 'export const candidate = 1', sourceModule)
			commitReady.resolve()
			await resumeCommit.promise
			// A second scoped write must not regain ownership after the ambient conflict.
			await transformWithExistingCollector(collector, 'export const candidate = 2', sourceModule)
		})
		await commitReady.promise
		await transformWithExistingCollector(
			collector,
			preloweredDefinitionSource(definition),
			sourceModule,
		)
		resumeCommit.resolve()
		await commitWork
		committed.commit()
		expect(collector.classifyDefinitionArtifact(definition, [sourceModule])).toBe('built-module')
	})

	describe('Workbench artifact generations', () => {
		function contentPlugin(className: string): string {
			return `
				import { BasePlugin, Plugin } from '@pluxel/runtime'
				import { workbench } from '@pluxel/runtime/workbench'
				export const pages = workbench.define({
					guide: workbench.content({
						document: workbench.markdown(import.meta.url, './guide.md'),
						placement: workbench.tab({ label: 'Guide' }),
					}),
				})
				@Plugin() export class ${className} extends BasePlugin {
					init() { this.ctx.workbench.publish(pages) }
				}
			`
		}

		async function expectOwner(
			collector: ReturnType<typeof createPluginSemanticsPlugin>,
			className: string,
		) {
			const definitions = collector.definitions()
			expect(definitions.map((definition) => definition.className)).toEqual([className])
			const content = await collector.workbenchContentCompilations()
			expect(content).toHaveLength(1)
			expect(content[0]!.contentSet.definition).toEqual(definitions[0]!.definition)
		}

		it.each(['commit', 'rollback'] as const)(
			'%s keeps Workbench publication and source facts in the same generation',
			async (settlement) => {
				await using fixture = await createFixture({
					'guide.md': '# Guide',
					'plugin.ts': contentPlugin('OriginalPlugin'),
				})
				const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
				const moduleId = fixture.getPath('plugin.ts')
				await transformWithExistingCollector(collector, contentPlugin('OriginalPlugin'), moduleId)
				await expectOwner(collector, 'OriginalPlugin')

				const generation = collector.beginArtifactGeneration()
				await generation.run(async () => {
					await transformWithExistingCollector(
						collector,
						contentPlugin('CandidatePlugin'),
						moduleId,
					)
					await expectOwner(collector, 'CandidatePlugin')
				})
				await expectOwner(collector, 'OriginalPlugin')
				generation[settlement]()
				await expectOwner(collector, settlement === 'commit' ? 'CandidatePlugin' : 'OriginalPlugin')
				await expect(collector.workbenchCompilations()).resolves.toEqual([])
			},
		)

		it.each([
			{ location: 'inline', settlement: 'rollback' },
			{ location: 'imported', settlement: 'rollback' },
			{ location: 'imported', settlement: 'commit' },
		] as const)(
			'keeps $location definitions consistent after a watched candidate $settlement',
			async ({ location, settlement }) => {
				const inlineSource = contentPlugin('OriginalPlugin')
				const declaration = inlineSource.slice(
					inlineSource.indexOf('export const pages'),
					inlineSource.indexOf('@Plugin()'),
				)
				const definitionSource = `import { workbench } from '@pluxel/runtime/workbench'
${declaration}`
				const pluginSource =
					location === 'inline'
						? inlineSource
						: inlineSource.replace(declaration, "import { pages } from './workbench'\n")
				await using fixture = await createFixture({
					'guide.md': '# Guide',
					'plugin.ts': pluginSource,
					'workbench.ts': definitionSource,
				})
				const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
				const moduleId = fixture.getPath('plugin.ts')
				const resolveImport = async (source: string) =>
					source === './workbench' ? { id: fixture.getPath('workbench.ts') } : null
				await transformWithExistingCollector(collector, pluginSource, moduleId, resolveImport)
				const accepted = await collector.workbenchContentCompilations()
				expect(accepted[0]!.contentSet.entries.map(({ key }) => key)).toEqual(['guide'])

				const changedId = location === 'inline' ? moduleId : fixture.getPath('workbench.ts')
				const changedSource = (location === 'inline' ? pluginSource : definitionSource).replace(
					'guide: workbench.content',
					'rejected: workbench.content',
				)
				await writeFile(changedId, changedSource)
				const watchChange = collector.plugin.watchChange as (
					id: string,
					change: { event: 'update' },
				) => void
				watchChange(changedId, { event: 'update' })
				const generation = collector.beginArtifactGeneration()
				await generation.run(async () => {
					await transformWithExistingCollector(
						collector,
						location === 'inline' ? changedSource : pluginSource,
						moduleId,
						resolveImport,
					)
					const candidate = await collector.workbenchContentCompilations()
					expect(candidate[0]!.contentSet.entries.map(({ key }) => key)).toEqual(['rejected'])
				})
				generation[settlement]()
				await expectOwner(collector, 'OriginalPlugin')
				const settled = await collector.workbenchContentCompilations()
				expect(settled[0]!.contentSet.entries.map(({ key }) => key)).toEqual(
					settlement === 'rollback' ? ['guide'] : ['rejected'],
				)
			},
		)

		it('rejects an older transform after a newer transform commits while import resolution is pending', async () => {
			await using fixture = await createFixture({
				'guide.md': '# Guide',
				'plugin.ts': contentPlugin('OriginalPlugin'),
				'slow.ts':
					"import { BasePlugin, Plugin } from '@pluxel/runtime'; @Plugin() export class Slow extends BasePlugin {}",
			})
			const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
			const moduleId = fixture.getPath('plugin.ts')
			const started = Promise.withResolvers<void>()
			const resume = Promise.withResolvers<void>()
			const oldSource = `import { Slow } from './slow'\n${contentPlugin('OldPlugin')}`.replace(
				'init() {',
				'constructor(readonly slow: Slow) { super() } init() {',
			)
			const pending = transformWithExistingCollector(
				collector,
				oldSource,
				moduleId,
				async (source) => {
					if (source !== './slow') return null
					started.resolve()
					await resume.promise
					return { id: fixture.getPath('slow.ts') }
				},
			)
			await started.promise
			try {
				await transformWithExistingCollector(collector, contentPlugin('NewPlugin'), moduleId)
				await expectOwner(collector, 'NewPlugin')
			} finally {
				resume.resolve()
				await pending
			}
			await expectOwner(collector, 'NewPlugin')
			await expect(collector.workbenchCompilations()).resolves.toEqual([])
		})

		it('preserves newer ambient Workbench facts when committing an older candidate', async () => {
			await using fixture = await createFixture({
				'guide.md': '# Guide',
				'plugin.ts': contentPlugin('OriginalPlugin'),
			})
			const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
			const moduleId = fixture.getPath('plugin.ts')
			await transformWithExistingCollector(collector, contentPlugin('OriginalPlugin'), moduleId)

			const generation = collector.beginArtifactGeneration()
			await generation.run(() =>
				transformWithExistingCollector(collector, contentPlugin('CandidatePlugin'), moduleId),
			)
			await transformWithExistingCollector(collector, contentPlugin('AmbientPlugin'), moduleId)
			await expectOwner(collector, 'AmbientPlugin')
			await generation.run(async () => {
				await expectOwner(collector, 'CandidatePlugin')
				// A later candidate write must not take ownership back from the ambient update.
				await transformWithExistingCollector(
					collector,
					contentPlugin('LaterCandidatePlugin'),
					moduleId,
				)
				await expectOwner(collector, 'LaterCandidatePlugin')
			})
			generation.commit()
			await expectOwner(collector, 'AmbientPlugin')
			await expect(collector.workbenchCompilations()).resolves.toEqual([])
		})

		it.each(['delete', 'ordinary module'] as const)(
			'withdraws Workbench publications after %s, including across candidate settlement',
			async (change) => {
				await using fixture = await createFixture({
					'guide.md': '# Guide',
					'plugin.ts': contentPlugin('OriginalPlugin'),
				})
				const collector = createPluginSemanticsPlugin({ root: fixture.getPath() })
				const moduleId = fixture.getPath('plugin.ts')
				await transformWithExistingCollector(collector, contentPlugin('OriginalPlugin'), moduleId)
				await expectOwner(collector, 'OriginalPlugin')
				const withdraw = async () => {
					if (change === 'delete') {
						const watchChange = collector.plugin.watchChange as (
							id: string,
							change: { event: 'delete' },
						) => void
						watchChange(moduleId, { event: 'delete' })
					} else {
						await transformWithExistingCollector(
							collector,
							'export const ordinary = true',
							moduleId,
						)
					}
					expect(collector.definitions()).toEqual([])
					await expect(collector.workbenchContentCompilations()).resolves.toEqual([])
				}

				const rejected = collector.beginArtifactGeneration()
				await rejected.run(withdraw)
				rejected.rollback()
				await expectOwner(collector, 'OriginalPlugin')

				const candidate = collector.beginArtifactGeneration()
				await candidate.run(() =>
					transformWithExistingCollector(collector, contentPlugin('CandidatePlugin'), moduleId),
				)
				await withdraw()
				candidate.commit()
				expect(collector.definitions()).toEqual([])
				await expect(collector.workbenchContentCompilations()).resolves.toEqual([])
			},
		)
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
