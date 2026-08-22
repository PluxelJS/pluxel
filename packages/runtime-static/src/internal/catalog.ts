import {
	formatPluginDefinitionReference,
	formatPluginNodeReference,
	getPluginDeclaration,
	getPluginDefinitionFacts,
	pluginNodeAddressOf,
	type PluginConfigDefinition,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginDefinitionSlot,
	type PluginEntryAddress,
	type PluginNodeAddress,
	type PluginNodeSlot,
	PluginSlotRegistry,
} from '@pluxel/core'
import type { StaticRuntimeDefinition } from '../types'

type ConfigShape = Readonly<{
	plugins: readonly Readonly<{
		owner: PluginNodeAddress
		config: Readonly<Record<string, unknown>>
	}>[]
}>

/**
 * One catalog definition and its current implementation generation.
 *
 * Slots are the in-memory identity. Addresses are the route/storage projection;
 * displayName and provenance are diagnostics only.
 */
export type StaticRuntimeCatalogEntryInternal = Readonly<{
	readonly definitionSlot: PluginDefinitionSlot
	readonly nodeSlot: PluginNodeSlot
	readonly definitionAddress: PluginDefinitionAddress
	readonly nodeAddress: PluginNodeAddress
	readonly generation: PluginConstructor
	readonly displayName: string
	readonly rootExport: string
	readonly provenance: PluginEntryAddress
	readonly required: readonly PluginDefinitionSlot[]
	readonly optional: readonly PluginDefinitionSlot[]
	readonly provides?: PluginDefinitionSlot
	readonly config?: PluginConfigDefinition
}>

export type StaticRuntimeCatalog = Readonly<{
	/** Must be reused when building the next HMR generation of this catalog. */
	readonly slots: PluginSlotRegistry
	readonly entries: readonly StaticRuntimeCatalogEntryInternal[]
	readonly byDefinition: ReadonlyMap<PluginDefinitionSlot, StaticRuntimeCatalogEntryInternal>
	readonly byNode: ReadonlyMap<PluginNodeSlot, StaticRuntimeCatalogEntryInternal>
	readonly byGeneration: ReadonlyMap<PluginConstructor, StaticRuntimeCatalogEntryInternal>
	/** Concrete and abstract definition tokens to all catalog candidates that provide them. */
	readonly providersByDefinition: ReadonlyMap<
		PluginDefinitionSlot,
		readonly StaticRuntimeCatalogEntryInternal[]
	>
}>

export type StaticRuntimeCatalogDiff = Readonly<{
	readonly added: readonly PluginNodeAddress[]
	readonly removed: readonly PluginNodeAddress[]
	readonly replaced: readonly PluginNodeAddress[]
}>

export type StaticRuntimeMissingDependency = Readonly<{
	readonly definition: PluginDefinitionAddress
	readonly candidates: readonly PluginNodeAddress[]
}>

/**
 * Builds the fixed route catalog from semantic facts emitted by the Pluxel toolchain.
 * The caller owns and must retain `slots` across HMR catalog generations.
 */
export function buildCatalog(
	definition: StaticRuntimeDefinition,
	slots: PluginSlotRegistry,
): StaticRuntimeCatalog {
	const entries: StaticRuntimeCatalogEntryInternal[] = []
	const byDefinition = new Map<PluginDefinitionSlot, StaticRuntimeCatalogEntryInternal>()
	const byNode = new Map<PluginNodeSlot, StaticRuntimeCatalogEntryInternal>()
	const byGeneration = new Map<PluginConstructor, StaticRuntimeCatalogEntryInternal>()
	const mutableProviders = new Map<PluginDefinitionSlot, StaticRuntimeCatalogEntryInternal[]>()

	for (const generation of definition.plugins) {
		const facts = getPluginDefinitionFacts(generation)
		if (facts.kind !== 'plugin') {
			throw new TypeError(
				`[runtime-static:catalog] ${formatPluginDefinitionReference(facts.definition)} is not a concrete Plugin definition`,
			)
		}
		const declaration = getPluginDeclaration(generation)
		const definitionSlot = slots.internDefinition(facts.definition)
		const nodeAddress = pluginNodeAddressOf(generation)
		if (nodeAddress.variant !== 'default') {
			throw new TypeError(
				`[runtime-static:catalog] root catalog entry ${formatPluginNodeReference(nodeAddress)} must be a default Plugin definition`,
			)
		}
		const nodeSlot = slots.internNode(nodeAddress)
		if (byDefinition.has(definitionSlot) || byNode.has(nodeSlot)) {
			throw new TypeError(
				`[runtime-static:catalog] duplicate Plugin definition ${formatPluginDefinitionReference(facts.definition)}`,
			)
		}
		if (byGeneration.has(generation)) {
			throw new TypeError(
				`[runtime-static:catalog] duplicate Plugin generation for ${formatPluginDefinitionReference(facts.definition)}`,
			)
		}

		const required = Object.freeze(facts.requires.map((address) => slots.internDefinition(address)))
		const optional = Object.freeze(facts.optional.map((address) => slots.internDefinition(address)))
		const provides = facts.provides ? slots.internDefinition(facts.provides) : undefined
		const entry: StaticRuntimeCatalogEntryInternal = Object.freeze({
			definitionSlot,
			nodeSlot,
			definitionAddress: facts.definition,
			nodeAddress,
			generation,
			displayName: declaration.displayName,
			rootExport: facts.definition.exportName,
			provenance: facts.definition.entry,
			required,
			optional,
			...(provides === undefined ? {} : { provides }),
			...(declaration.config === undefined ? {} : { config: declaration.config }),
		})
		entries.push(entry)
		byDefinition.set(definitionSlot, entry)
		byNode.set(nodeSlot, entry)
		byGeneration.set(generation, entry)
		addProvider(mutableProviders, definitionSlot, entry)
		if (provides) addProvider(mutableProviders, provides, entry)
	}

	const providersByDefinition = new Map<
		PluginDefinitionSlot,
		readonly StaticRuntimeCatalogEntryInternal[]
	>()
	for (const [token, providers] of mutableProviders) {
		providersByDefinition.set(token, Object.freeze(providers.slice()))
	}

	return Object.freeze({
		slots,
		entries: Object.freeze(entries),
		byDefinition,
		byNode,
		byGeneration,
		providersByDefinition,
	})
}

export function diffCatalog(
	previous: StaticRuntimeCatalog,
	next: StaticRuntimeCatalog,
): StaticRuntimeCatalogDiff {
	if (previous.slots !== next.slots) {
		throw new TypeError(
			'[runtime-static:catalog] catalog diff requires the same PluginSlotRegistry across generations',
		)
	}

	const added: PluginNodeAddress[] = []
	const removed: PluginNodeAddress[] = []
	const replaced: PluginNodeAddress[] = []

	for (const [node, entry] of next.byNode) {
		const prior = previous.byNode.get(node)
		if (!prior) added.push(entry.nodeAddress)
		else if (prior.generation !== entry.generation) replaced.push(entry.nodeAddress)
	}
	for (const [node, entry] of previous.byNode) {
		if (!next.byNode.has(node)) removed.push(entry.nodeAddress)
	}

	return Object.freeze({
		added: Object.freeze(added),
		removed: Object.freeze(removed),
		replaced: Object.freeze(replaced),
	})
}

export function firstMissingDependency(
	entry: StaticRuntimeCatalogEntryInternal,
	catalog: StaticRuntimeCatalog,
	enabled: ReadonlySet<PluginNodeSlot>,
	blocked: ReadonlySet<PluginNodeSlot>,
): StaticRuntimeMissingDependency | undefined {
	for (const definition of entry.required) {
		const candidates = catalog.providersByDefinition.get(definition) ?? []
		if (
			candidates.some(
				(candidate) => enabled.has(candidate.nodeSlot) && !blocked.has(candidate.nodeSlot),
			)
		) {
			continue
		}
		return Object.freeze({
			definition: catalog.slots.definitionAddress(definition),
			candidates: Object.freeze(candidates.map((candidate) => candidate.nodeAddress)),
		})
	}
	return undefined
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
	enabled: Iterable<PluginNodeAddress> = [],
): PluginNodeAddress[] {
	const unknown = new Map<PluginNodeSlot, PluginNodeAddress>()
	for (const address of enabled) collectUnknownNode(address, catalog, unknown)
	for (const record of snapshot.plugins) collectUnknownNode(record.owner, catalog, unknown)
	return [...unknown.values()].sort((left, right) =>
		formatPluginNodeReference(left).localeCompare(formatPluginNodeReference(right)),
	)
}

function addProvider(
	providers: Map<PluginDefinitionSlot, StaticRuntimeCatalogEntryInternal[]>,
	definition: PluginDefinitionSlot,
	entry: StaticRuntimeCatalogEntryInternal,
): void {
	const current = providers.get(definition)
	if (current) current.push(entry)
	else providers.set(definition, [entry])
}

function collectUnknownNode(
	address: PluginNodeAddress,
	catalog: StaticRuntimeCatalog,
	unknown: Map<PluginNodeSlot, PluginNodeAddress>,
): void {
	const node = catalog.slots.internNode(address)
	const known =
		catalog.byNode.has(node) ||
		(address.variant === 'fork' && catalog.byDefinition.has(node.definition))
	if (!known) unknown.set(node, catalog.slots.nodeAddress(node))
}
