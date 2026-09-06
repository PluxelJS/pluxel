import {
	BasePlugin,
	Plugin,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/test/unsafe'
import { describe, expect, it } from 'vitest'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	readConfigSnapshot,
} from '../src/internal/catalog'

const MANUAL_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'unreported' as const }),
	update: Object.freeze({ kind: 'manual' as const }),
})

const SOURCE_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'source-module' as const }),
	update: Object.freeze({ kind: 'catalog-hmr' as const }),
})

const BUILT_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'built-module' as const }),
	update: Object.freeze({ kind: 'catalog-hmr' as const }),
})

const resolveManualExecution = () => MANUAL_EXECUTION

const packageDefinition = (packageName: string, exportName: string): PluginDefinitionAddress => ({
	entry: { kind: 'package-root', packageName },
	exportName,
})

function loweredImplementation(
	implementation: PluginConstructor,
	definition: PluginDefinitionAddress,
	options: {
		displayName?: string
		requires?: readonly PluginDefinitionAddress[]
		optional?: readonly PluginDefinitionAddress[]
		provides?: PluginDefinitionAddress
	} = {},
): PluginConstructor {
	Plugin(options.displayName ? { displayName: options.displayName } : undefined)(implementation)
	__setPluginDefinition(implementation, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition,
		...(options.requires ? { constructorRequires: options.requires } : {}),
		...(options.optional ? { optional: options.optional } : {}),
		...(options.provides ? { provides: options.provides } : {}),
	})
	return implementation
}

describe('static runtime catalog identity', () => {
	it('keys definitions by lowered address rather than implementation or display name', () => {
		const First = loweredImplementation(
			class SharedPlugin extends BasePlugin {},
			packageDefinition('@fixture/first', 'RootPlugin'),
			{ displayName: 'Shared' },
		)
		const Second = loweredImplementation(
			class SharedPlugin extends BasePlugin {},
			packageDefinition('@fixture/first', 'OtherPlugin'),
			{ displayName: 'Shared' },
		)
		const Third = loweredImplementation(
			class SharedPlugin extends BasePlugin {},
			packageDefinition('@fixture/second', 'RootPlugin'),
			{ displayName: 'Shared' },
		)
		const catalog = buildCatalog(
			{ name: 'identity', plugins: [First, Second, Third] },
			1,
			(definition) =>
				definition.exportName === 'OtherPlugin' ? SOURCE_EXECUTION : BUILT_EXECUTION,
		)

		expect(catalog.entries).toHaveLength(3)
		expect(catalog.entries.map((entry) => entry.candidate.declaration.displayName)).toEqual([
			'Shared',
			'Shared',
			'Shared',
		])
		expect(catalog.entries.map((entry) => entry.address)).toEqual(
			expect.arrayContaining([
				packageDefinition('@fixture/first', 'OtherPlugin'),
				packageDefinition('@fixture/first', 'RootPlugin'),
				packageDefinition('@fixture/second', 'RootPlugin'),
			]),
		)
		expect(
			catalog.entries.map((entry) => [
				entry.address.entry.kind === 'package-root'
					? entry.address.entry.packageName
					: entry.address.entry.path,
				entry.address.exportName,
				entry.provenance.execution?.artifact.kind,
				entry.provenance.execution?.update.kind,
			]),
		).toEqual(
			expect.arrayContaining([
				['@fixture/first', 'OtherPlugin', 'source-module', 'catalog-hmr'],
				['@fixture/first', 'RootPlugin', 'built-module', 'catalog-hmr'],
				['@fixture/second', 'RootPlugin', 'built-module', 'catalog-hmr'],
			]),
		)
	})

	it('detects implementation replacement without allocating Core slots', () => {
		const definition = packageDefinition('@fixture/hot', 'HotPlugin')
		const First = loweredImplementation(class HotPlugin extends BasePlugin {}, definition)
		const Second = loweredImplementation(class HotPlugin extends BasePlugin {}, definition)
		const previous = buildCatalog({ name: 'hot', plugins: [First] }, 1, resolveManualExecution)
		const next = buildCatalog({ name: 'hot', plugins: [Second] }, 2, resolveManualExecution)

		expect(previous.entries[0]?.candidate.implementation).toBe(First)
		expect(next.entries[0]?.candidate.implementation).toBe(Second)
		expect(diffCatalog(previous, next)).toEqual({
			added: [],
			removed: [],
			replaced: [{ definition, variant: 'default' }],
		})
	})

	it('rejects duplicate definition identity and unlowered implementations', () => {
		const definition = packageDefinition('@fixture/duplicate', 'DuplicatePlugin')
		const First = loweredImplementation(class DuplicatePlugin extends BasePlugin {}, definition)
		const Second = loweredImplementation(class DuplicatePlugin extends BasePlugin {}, definition)
		expect(() =>
			buildCatalog({ name: 'duplicate', plugins: [First, Second] }, 1, resolveManualExecution),
		).toThrow(/duplicate Plugin definition/)

		const Raw = class RawPlugin extends BasePlugin {}
		Plugin()(Raw)
		expect(() => buildCatalog({ name: 'raw', plugins: [Raw] }, 1, resolveManualExecution)).toThrow(
			/not lowered/,
		)
	})

	it('finds unknown config and control-state owners by structured node address', () => {
		const definition = packageDefinition('@fixture/known', 'KnownPlugin')
		const Known = loweredImplementation(class KnownPlugin extends BasePlugin {}, definition)
		const catalog = buildCatalog({ name: 'config', plugins: [Known] }, 1, resolveManualExecution)
		const known: PluginNodeAddress = { definition, variant: 'default' }
		const unknown: PluginNodeAddress = {
			definition: packageDefinition('@fixture/unknown', 'UnknownPlugin'),
			variant: 'default',
		}
		const snapshot = readConfigSnapshot({
			getConfigSnapshot: () => ({
				plugins: [
					{ owner: known, config: {} },
					{ owner: unknown, config: { value: true } },
				],
			}),
		})

		expect(collectUnknownConfigEntries(snapshot, catalog, [unknown, unknown])).toEqual([unknown])
	})
})
