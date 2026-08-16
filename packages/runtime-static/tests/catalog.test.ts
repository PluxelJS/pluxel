import {
	__setPluginDefinition,
	BasePlugin,
	Plugin,
	PluginSlotRegistry,
	type PluginConstructor,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { describe, expect, it } from 'vitest'
import {
	buildCatalog,
	collectUnknownConfigEntries,
	diffCatalog,
	firstMissingDependency,
	readConfigSnapshot,
} from '../src/internal/catalog'

const packageDefinition = (
	packageName: string,
	exportName: string,
): PluginDefinitionAddressSnapshot => ({
	entry: { kind: 'package-root', packageName },
	exportName,
})

function loweredGeneration(
	generation: PluginConstructor,
	definition: PluginDefinitionAddressSnapshot,
	options: {
		displayName?: string
		requires?: readonly PluginDefinitionAddressSnapshot[]
		optional?: readonly PluginDefinitionAddressSnapshot[]
		provides?: PluginDefinitionAddressSnapshot
	} = {},
): PluginConstructor {
	Plugin(options.displayName ? { displayName: options.displayName } : undefined)(generation)
	__setPluginDefinition(generation, {
		kind: 'plugin',
		definition,
		...(options.requires ? { requires: options.requires } : {}),
		...(options.optional ? { optional: options.optional } : {}),
		...(options.provides ? { provides: options.provides } : {}),
	})
	return generation
}

describe('static runtime catalog identity', () => {
	it('allows matching class and display names when definition provenance differs', () => {
		const First = loweredGeneration(
			class SharedPlugin extends BasePlugin {},
			packageDefinition('@fixture/first', 'RootPlugin'),
			{ displayName: 'Shared' },
		)
		const Second = loweredGeneration(
			class SharedPlugin extends BasePlugin {},
			packageDefinition('@fixture/first', 'OtherPlugin'),
			{ displayName: 'Shared' },
		)
		const Third = loweredGeneration(
			class SharedPlugin extends BasePlugin {},
			packageDefinition('@fixture/second', 'RootPlugin'),
			{ displayName: 'Shared' },
		)
		const slots = new PluginSlotRegistry()
		const catalog = buildCatalog({ name: 'identity', plugins: [First, Second, Third] }, slots)

		expect(First.name).toBe(Second.name)
		expect(Second.name).toBe(Third.name)
		expect(catalog.entries).toHaveLength(3)
		expect(catalog.entries.map(({ displayName }) => displayName)).toEqual([
			'Shared',
			'Shared',
			'Shared',
		])
		expect(catalog.entries.map(({ rootExport }) => rootExport)).toEqual([
			'RootPlugin',
			'OtherPlugin',
			'RootPlugin',
		])
		expect(catalog.entries.map(({ provenance }) => provenance)).toEqual([
			{ kind: 'package-root', packageName: '@fixture/first' },
			{ kind: 'package-root', packageName: '@fixture/first' },
			{ kind: 'package-root', packageName: '@fixture/second' },
		])
		expect(catalog.byGeneration.get(First)?.nodeSlot).not.toBe(
			catalog.byGeneration.get(Second)?.nodeSlot,
		)
	})

	it('uses a stable node slot to detect constructor generation replacement', () => {
		const definition = packageDefinition('@fixture/hot', 'HotPlugin')
		const First = loweredGeneration(class HotPlugin extends BasePlugin {}, definition)
		const Second = loweredGeneration(class HotPlugin extends BasePlugin {}, definition)
		const slots = new PluginSlotRegistry()
		const previous = buildCatalog({ name: 'hot', plugins: [First] }, slots)
		const next = buildCatalog({ name: 'hot', plugins: [Second] }, slots)

		expect(previous.entries[0]?.nodeSlot).toBe(next.entries[0]?.nodeSlot)
		expect(previous.entries[0]?.displayName).toBe('HotPlugin')
		expect(diffCatalog(previous, next)).toEqual({
			added: [],
			removed: [],
			replaced: [next.entries[0]?.nodeAddress],
		})
		expect(() =>
			diffCatalog(
				previous,
				buildCatalog({ name: 'hot', plugins: [Second] }, new PluginSlotRegistry()),
			),
		).toThrow(/same PluginSlotRegistry/)
	})

	it('resolves required facts through enabled definition providers without reflection', () => {
		const abstract = packageDefinition('@fixture/provider', 'ProviderToken')
		const providerDefinition = packageDefinition('@fixture/provider', 'ProviderPlugin')
		const consumerDefinition = packageDefinition('@fixture/consumer', 'ConsumerPlugin')
		const Provider = loweredGeneration(
			class ProviderPlugin extends BasePlugin {},
			providerDefinition,
			{ provides: abstract },
		)
		const Consumer = loweredGeneration(
			class ConsumerPlugin extends BasePlugin {},
			consumerDefinition,
			{ requires: [abstract] },
		)
		const catalog = buildCatalog(
			{ name: 'dependency', plugins: [Provider, Consumer] },
			new PluginSlotRegistry(),
		)
		const provider = catalog.byGeneration.get(Provider)!
		const consumer = catalog.byGeneration.get(Consumer)!
		const enabled = new Set([consumer.nodeSlot])

		expect(firstMissingDependency(consumer, catalog, enabled, new Set())).toEqual({
			definition: abstract,
			candidates: [provider.nodeAddress],
		})
		enabled.add(provider.nodeSlot)
		expect(firstMissingDependency(consumer, catalog, enabled, new Set())).toBeUndefined()
		expect(
			firstMissingDependency(consumer, catalog, enabled, new Set([provider.nodeSlot])),
		).toEqual({
			definition: abstract,
			candidates: [provider.nodeAddress],
		})
	})

	it('rejects duplicate definition identity and unlowered generations', () => {
		const definition = packageDefinition('@fixture/duplicate', 'DuplicatePlugin')
		const First = loweredGeneration(class DuplicatePlugin extends BasePlugin {}, definition)
		const Second = loweredGeneration(class DuplicatePlugin extends BasePlugin {}, definition)
		expect(() =>
			buildCatalog({ name: 'duplicate', plugins: [First, Second] }, new PluginSlotRegistry()),
		).toThrow(/duplicate Plugin definition/)

		const Raw = class RawPlugin extends BasePlugin {}
		Plugin()(Raw)
		expect(() => buildCatalog({ name: 'raw', plugins: [Raw] }, new PluginSlotRegistry())).toThrow(
			/was not lowered/,
		)
	})

	it('finds unknown config and enablement owners by structured node address', () => {
		const Known = loweredGeneration(
			class KnownPlugin extends BasePlugin {},
			packageDefinition('@fixture/known', 'KnownPlugin'),
		)
		const catalog = buildCatalog({ name: 'config', plugins: [Known] }, new PluginSlotRegistry())
		const unknown: PluginNodeAddressSnapshot = {
			definition: packageDefinition('@fixture/unknown', 'UnknownPlugin'),
			instance: 'default',
		}
		const snapshot = readConfigSnapshot({
			getConfigSnapshot: () => ({
				plugins: [
					{ owner: catalog.entries[0]!.nodeAddress, config: {} },
					{ owner: unknown, config: { value: true } },
				],
			}),
		})

		expect(collectUnknownConfigEntries(snapshot, catalog, [unknown, unknown])).toEqual([unknown])
	})
})
