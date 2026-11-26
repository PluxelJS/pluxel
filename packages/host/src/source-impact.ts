import {
	comparePluginNodeAddress,
	parsePluginEntryAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { isAbsolute, normalize } from 'node:path'
import type { CorePluginDependencyAdjacencyEdge, HostPluginGraphCommittedView } from './coordinator'
import { requirePluginHostCoordinator } from './install'
import { hostPluginCatalogEntriesFromView } from './status'
import {
	reviewSourceDependencies,
	type PluginSourceDependencyReview,
	type PluginSourcePublication,
} from './source-dependencies'

/** Current graph facts scoped to the reviewed publications. Each effective edge is a direct Core edge. */
export type PluginSourceImpact = Readonly<{
	catalogRevision: number
	policyRevision: number
	/** Present when the caller supplies proposed entry operations. */
	dependencyReview?: PluginSourceDependencyReview
	definitions: readonly Readonly<{
		/** Package being reviewed. A re-export can have a different canonical definition owner. */
		packageName: string
		address: PluginDefinitionAddress
		origin: 'owned' | 'shared' | 'fixed' | 'other-source' | 'unreported'
		nodes: readonly Readonly<{
			address: PluginNodeAddress
			running: boolean
			requiredConsumers: readonly PluginNodeAddress[]
			optionalConsumers: readonly PluginNodeAddress[]
		}>[]
	}>[]
}>

export class PluginSourceBusyError extends Error {
	readonly code = 'HOST_GRAPH_BUSY'

	constructor() {
		super('A Host graph operation is pending. Review the publication again after settlement.')
		this.name = 'PluginSourceBusyError'
	}
}

/**
 * Observe the admitted identities, nodes and active dependency bindings for these package entries.
 * Pass the absolute physical paths that the producer publishes. Call again immediately before
 * committing the publication. Throws PluginSourceBusyError while the Host queue is mutating.
 */
export function readPluginSourceImpact(
	ctx: Context,
	packages: readonly (
		| Readonly<{ name: string; file: string; action?: undefined }>
		| PluginSourcePublication
	)[],
): PluginSourceImpact {
	const files = new Map<string, string>()
	const names = new Set<string>()
	for (const { name, file, action } of packages) {
		if (action !== undefined && action !== 'publish' && action !== 'withdraw')
			throw new TypeError('[host/sources] unknown publication action')
		parsePluginEntryAddress({ kind: 'package-root', packageName: name })
		const path = normalize(file)
		if (!isAbsolute(path) || file.includes('\0') || files.has(path) || names.has(name))
			throw new TypeError('[host/sources] each package requires a distinct name and absolute file')
		files.set(path, name)
		names.add(name)
	}
	const publications = packages.filter(
		(entry): entry is PluginSourcePublication => entry.action !== undefined,
	)
	const impact = requirePluginHostCoordinator(ctx).readCommittedIfIdle((view) => ({
		...projectImpact(view, names, files),
		...(publications.length > 0 && {
			dependencyReview: reviewSourceDependencies(view, publications),
		}),
	}))
	if (impact === undefined) throw new PluginSourceBusyError()
	return impact
}

function projectImpact(
	view: HostPluginGraphCommittedView,
	packages: ReadonlySet<string>,
	files: ReadonlyMap<string, string>,
): PluginSourceImpact {
	const running = new Set(view.runningNodes.map(pluginNodeIndexKey))
	const entries = hostPluginCatalogEntriesFromView({
		catalog: view.catalog,
		declaredNodes: view.declaredNodes,
		state: view.runtimeState.state,
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		coreNodes: view.coreAdjacency.nodes,
		runningNodeKeys: running,
	})
	const byDefinition = Map.groupBy(entries, ({ address }) =>
		pluginDefinitionIndexKey(address.definition),
	)
	const required = consumersByProvider(view.coreAdjacency.required)
	const optional = consumersByProvider(view.coreAdjacency.optional)
	const definitions: PluginSourceImpact['definitions'][number][] = []
	for (const { address, indexKey, provenance } of view.catalog.entries) {
		const owners = new Set<string>()
		if (address.entry.kind !== 'source-entry' && packages.has(address.entry.packageName))
			owners.add(address.entry.packageName)
		const sources = provenance.sourceFiles ?? []
		const providing = new Set<string>()
		for (const file of sources) {
			const name = files.get(normalize(file))
			if (name !== undefined) {
				providing.add(name)
				owners.add(name)
			}
		}
		if (owners.size === 0) continue
		const nodes = (byDefinition.get(indexKey) ?? [])
			.map(({ address: node }) => {
				const key = pluginNodeIndexKey(node)
				return {
					address: node,
					running: running.has(key),
					requiredConsumers: required.get(key) ?? [],
					optionalConsumers: optional.get(key) ?? [],
				}
			})
			.sort((left, right) => comparePluginNodeAddress(left.address, right.address))
		const execution = provenance.execution
		for (const packageName of [...owners].sort()) {
			let origin: PluginSourceImpact['definitions'][number]['origin'] = 'unreported'
			if (execution && execution.kind !== 'unreported') {
				if (execution.origin === 'fixed') origin = 'fixed'
				else if (providing.has(packageName)) origin = sources.length === 1 ? 'owned' : 'shared'
				else if (sources.length > 0) origin = 'other-source'
			}
			definitions.push({ packageName, address, origin, nodes })
		}
	}
	return {
		catalogRevision: view.catalog.revision,
		policyRevision: view.runtimeState.revision,
		definitions,
	}
}

function consumersByProvider(edges: readonly CorePluginDependencyAdjacencyEdge[]) {
	const result = new Map<string, PluginNodeAddress[]>()
	for (const { provider, consumer } of edges) {
		const key = pluginNodeIndexKey(provider)
		const consumers = result.get(key)
		if (consumers) consumers.push(consumer)
		else result.set(key, [consumer])
	}
	for (const consumers of result.values()) consumers.sort(comparePluginNodeAddress)
	return result
}
