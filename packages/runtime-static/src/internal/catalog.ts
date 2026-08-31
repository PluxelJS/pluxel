import { formatPluginNodeReference, pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import {
	createPluginRouteCatalogSnapshot,
	pluginCatalogEntry,
	type PluginRouteCatalogEntry,
	type PluginRouteCatalogSnapshot,
} from '@pluxel/runtime/internal'
import type { StaticRuntimeDefinition } from '../types.ts'

type ConfigShape = Readonly<{
	plugins: readonly Readonly<{
		owner: PluginNodeAddress
		config: Readonly<Record<string, unknown>>
	}>[]
}>

export type StaticRuntimeCatalog = PluginRouteCatalogSnapshot
export type StaticRuntimeCatalogEntryInternal = PluginRouteCatalogEntry

export type StaticRuntimeCatalogDiff = Readonly<{
	readonly added: readonly PluginNodeAddress[]
	readonly removed: readonly PluginNodeAddress[]
	readonly replaced: readonly PluginNodeAddress[]
}>

export function buildCatalog(
	definition: StaticRuntimeDefinition,
	revision: number,
): StaticRuntimeCatalog {
	return createPluginRouteCatalogSnapshot(
		revision,
		definition.plugins.map((implementation) => ({
			candidate: readCandidate(implementation),
			provenance: Object.freeze({}),
		})),
	)
}

function readCandidate(implementation: StaticRuntimeDefinition['plugins'][number]) {
	return consumePluginDefinitionCandidate(implementation)
}

export function diffCatalog(
	previous: StaticRuntimeCatalog,
	next: StaticRuntimeCatalog,
): StaticRuntimeCatalogDiff {
	const added: PluginNodeAddress[] = []
	const removed: PluginNodeAddress[] = []
	const replaced: PluginNodeAddress[] = []
	for (const entry of next.entries) {
		const address: PluginNodeAddress = { definition: entry.address, variant: 'default' }
		const prior = previous.byDefinition.get(entry.indexKey)
		if (!prior) added.push(address)
		else if (prior.candidate !== entry.candidate) replaced.push(address)
	}
	for (const entry of previous.entries) {
		if (!next.byDefinition.has(entry.indexKey)) {
			removed.push({ definition: entry.address, variant: 'default' })
		}
	}
	return Object.freeze({
		added: Object.freeze(added),
		removed: Object.freeze(removed),
		replaced: Object.freeze(replaced),
	})
}

export type ConfigSnapshotReader = {
	getConfigSnapshot(): ConfigShape
}

export function readConfigSnapshot(configService: ConfigSnapshotReader): ConfigShape {
	return configService.getConfigSnapshot()
}

export function collectUnknownConfigEntries(
	snapshot: ConfigShape,
	catalog: StaticRuntimeCatalog,
	knownControlNodes: Iterable<PluginNodeAddress> = [],
): PluginNodeAddress[] {
	const unknown = new Map<string, PluginNodeAddress>()
	for (const address of knownControlNodes) collectUnknownNode(address, catalog, unknown)
	for (const record of snapshot.plugins) collectUnknownNode(record.owner, catalog, unknown)
	return [...unknown.values()].sort((left, right) =>
		formatPluginNodeReference(left).localeCompare(formatPluginNodeReference(right)),
	)
}

function collectUnknownNode(
	address: PluginNodeAddress,
	catalog: StaticRuntimeCatalog,
	unknown: Map<string, PluginNodeAddress>,
): void {
	const definition = pluginCatalogEntry(catalog, address.definition)
	if (definition) return
	unknown.set(pluginNodeIndexKey(address), address)
}
