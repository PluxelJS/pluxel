import {
	formatPluginDefinitionReference,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import {
	clonePluginExecutionSnapshot,
	type PluginExecutionSnapshot,
} from '../../plugin-execution'

export type PluginCatalogErrorCode =
	| 'plugin_definition_collision'
	| 'plugin_definition_role_conflict'
	| 'plugin_optional_abstract_forbidden'

export class PluginCatalogError extends Error {
	constructor(
		public readonly code: PluginCatalogErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'PluginCatalogError'
	}
}

export type PluginRouteCatalogProvenance = Readonly<{
	/** Route-owned module identity. It never enters Core identity or graph state. */
	moduleId?: string
	/** Immutable execution fact projected to management clients without physical module identity. */
	execution?: PluginExecutionSnapshot
	/** Route-owned artifact/build input. Core must never receive this value. */
	artifactInput?: unknown
}>

export type PluginRouteCatalogEntry = Readonly<{
	address: PluginDefinitionAddress
	indexKey: string
	candidate: ConcretePluginDefinitionCandidate
	provenance: PluginRouteCatalogProvenance
}>

export type PluginRouteCatalogSnapshot = Readonly<{
	revision: number
	entries: readonly PluginRouteCatalogEntry[]
	byDefinition: ReadonlyMap<string, PluginRouteCatalogEntry>
}>

export type PluginDefinitionRole = 'concrete' | 'abstract'

export type PluginDefinitionRoleHistory = ReadonlyMap<
	string,
	Readonly<{
		address: PluginDefinitionAddress
		role: PluginDefinitionRole
	}>
>

export type PluginRouteCatalogEntryInput = Readonly<{
	candidate: ConcretePluginDefinitionCandidate
	provenance?: PluginRouteCatalogProvenance
}>

export function createPluginRouteCatalogSnapshot(
	revision: number,
	inputs: Iterable<PluginRouteCatalogEntryInput>,
): PluginRouteCatalogSnapshot {
	if (!Number.isSafeInteger(revision) || revision < 0) {
		throw new TypeError('[runtime:catalog] revision must be a non-negative safe integer')
	}

	const entries: PluginRouteCatalogEntry[] = []
	const byDefinition = new Map<string, PluginRouteCatalogEntry>()
	const concreteRoles = new Set<string>()
	const abstractRoles = new Map<string, PluginDefinitionAddress>()

	for (const input of inputs) {
		const address = input.candidate.declaration.address
		const indexKey = pluginDefinitionIndexKey(address)
		if (byDefinition.has(indexKey)) {
			throw new PluginCatalogError(
				'plugin_definition_collision',
				`[runtime:catalog] duplicate Plugin definition ${formatPluginDefinitionReference(address)}`,
			)
		}
		if (abstractRoles.has(indexKey)) {
			throw roleConflict(address)
		}

		const provides = input.candidate.declaration.provides
		if (provides) {
			const tokenKey = pluginDefinitionIndexKey(provides)
			if (concreteRoles.has(tokenKey) || tokenKey === indexKey) throw roleConflict(provides)
			abstractRoles.set(tokenKey, provides)
		}

		const provenance = input.provenance
		const entry = Object.freeze({
			address,
			indexKey,
			candidate: input.candidate,
			provenance: Object.freeze({
				...provenance,
				...(provenance?.execution === undefined
					? {}
					: {
							execution: clonePluginExecutionSnapshot(
								provenance.execution,
								`Plugin catalog execution for ${formatPluginDefinitionReference(address)}`,
							),
						}),
			}),
		})
		concreteRoles.add(indexKey)
		entries.push(entry)
		byDefinition.set(indexKey, entry)
	}

	// A concrete role can appear after an earlier provider introduced the same abstract role.
	for (const entry of entries) {
		if (abstractRoles.has(entry.indexKey)) throw roleConflict(entry.address)
		for (const optional of entry.candidate.declaration.optional) {
			if (!abstractRoles.has(pluginDefinitionIndexKey(optional))) continue
			throw optionalAbstractForbidden(optional)
		}
	}

	entries.sort((left, right) => left.indexKey.localeCompare(right.indexKey))
	return Object.freeze({
		revision,
		entries: Object.freeze(entries),
		byDefinition,
	})
}

export function emptyPluginRouteCatalogSnapshot(): PluginRouteCatalogSnapshot {
	return createPluginRouteCatalogSnapshot(0, [])
}

export function pluginCatalogEntry(
	catalog: PluginRouteCatalogSnapshot,
	definition: PluginDefinitionAddress,
): PluginRouteCatalogEntry | undefined {
	return catalog.byDefinition.get(pluginDefinitionIndexKey(definition))
}

/**
 * Prepares the host-lifetime definition-role history for a catalog publication.
 *
 * A definition address cannot change between a concrete Plugin and an abstract capability token
 * during one host lifetime, including across an absent intermediate catalog. The returned map is
 * detached from the committed history so publication at the graph PONR is one field assignment.
 */
export function extendPluginDefinitionRoleHistory(
	committed: PluginDefinitionRoleHistory,
	catalog: PluginRouteCatalogSnapshot,
): PluginDefinitionRoleHistory {
	const next = new Map(committed)
	for (const entry of catalog.entries) {
		assertRole(next, entry.address, 'concrete')
		const provides = entry.candidate.declaration.provides
		if (provides) assertRole(next, provides, 'abstract')
	}
	for (const entry of catalog.entries) {
		for (const optional of entry.candidate.declaration.optional) {
			if (next.get(pluginDefinitionIndexKey(optional))?.role !== 'abstract') continue
			throw optionalAbstractForbidden(optional)
		}
	}
	return next
}

function assertRole(
	history: Map<string, Readonly<{ address: PluginDefinitionAddress; role: PluginDefinitionRole }>>,
	address: PluginDefinitionAddress,
	role: PluginDefinitionRole,
): void {
	const key = pluginDefinitionIndexKey(address)
	const previous = history.get(key)
	if (previous && previous.role !== role) throw roleConflict(address)
	if (!previous) history.set(key, Object.freeze({ address, role }))
}

function roleConflict(address: PluginDefinitionAddress): PluginCatalogError {
	return new PluginCatalogError(
		'plugin_definition_role_conflict',
		`[runtime:catalog] ${formatPluginDefinitionReference(address)} cannot be both a concrete Plugin and an abstract capability token`,
	)
}

function optionalAbstractForbidden(address: PluginDefinitionAddress): PluginCatalogError {
	return new PluginCatalogError(
		'plugin_optional_abstract_forbidden',
		`[runtime:catalog] optional Plugin dependency ${formatPluginDefinitionReference(address)} cannot bind through an abstract provider role`,
	)
}
