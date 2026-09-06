import {
	comparePluginDefinitionAddress,
	comparePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	requireRuntimePluginGraphCoordinator,
	type CorePluginDependencyAdjacencyEdge,
	type RuntimePluginGraphCommittedView,
} from '../../internal/reconciliation'
import { readRuntimeRouteCapabilities } from '../../runtime/capabilities'
import {
	clonePluginExecutionSnapshot,
	clonePluginRecentUpdateSnapshot,
} from '../../plugin-execution'
import type {
	PluginDependencyGraphEdge,
	PluginDependencyGraphNode,
	PluginDependencyGraphSnapshot,
	PluginStatusSnapshot,
} from '../../web/protocol'
import {
	projectPluginCatalogFromView,
	type PluginCatalogProjectionEntry,
} from '../features/plugins/catalog-projection'

export function pluginDependencyGraph(ctx: Context): Promise<PluginDependencyGraphSnapshot> {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	return coordinator.readCommitted((view) => projectPluginDependencyGraph(ctx, view))
}

/** @internal Pure presenter over one coordinator-pinned committed process view. */
export function projectPluginDependencyGraph(
	ctx: Context,
	view: RuntimePluginGraphCommittedView,
): PluginDependencyGraphSnapshot {
	const runningNodeKeys = new Set(view.runningNodes.map(pluginNodeIndexKey))
	const catalog = projectPluginCatalogFromView(ctx.root, {
		catalog: view.catalog,
		state: view.runtimeState.state,
		reconciliation: view.reconciliation,
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		coreNodes: view.coreAdjacency.nodes,
		runningNodeKeys,
		recentUpdate: readRuntimeRouteCapabilities(ctx)?.recentUpdate,
	})
	const appliedNodeKeys = new Set(view.applied.nodes.keys())
	const coreNodeKeys = new Set(view.coreAdjacency.nodes.map(pluginNodeIndexKey))
	assertSameNodeMembership(appliedNodeKeys, coreNodeKeys)

	const nodes = catalog.entries
		.map((entry) =>
			Object.freeze({
				status: freezePluginStatus(entry),
				effective: appliedNodeKeys.has(entry.nodeKey),
			}),
		)
		.sort((left, right) => comparePluginNodeAddress(left.status.address, right.status.address))
	const nodesByKey = new Map(nodes.map((node) => [pluginNodeIndexKey(node.status.address), node]))
	for (const node of nodes) {
		if (!node.effective) continue
		if (node.status.desiredState !== 'running' || node.status.availability !== 'available') {
			throw new Error('[runtime:dependency-graph] effective Core node is not desired and available')
		}
	}

	const requiredAdjacency = adjacencyIndex(view.coreAdjacency.required)
	const optionalAdjacency = adjacencyIndex(view.coreAdjacency.optional)
	const overrides = new Map(
		view.runtimeState.state.dependencyOverrides.map((binding) => [
			edgeIdentityKey(binding.consumerAddress, binding.requirementAddress),
			binding.providerAddress,
		]),
	)
	const providerDefaults = new Map(
		view.runtimeState.state.providerDefaults.map((binding) => [
			pluginDefinitionIndexKey(binding.token),
			binding.provider,
		]),
	)
	const forkIdsByDefinition = new Map<string, readonly string[]>()
	for (const family of view.runtimeState.state.forks) {
		forkIdsByDefinition.set(pluginDefinitionIndexKey(family.definition), family.forkIds)
	}

	const edges: PluginDependencyGraphEdge[] = []
	for (const entry of view.catalog.entries) {
		const declaration = entry.candidate.declaration
		const consumers: PluginNodeAddress[] = [
			Object.freeze({ definition: declaration.address, variant: 'default' as const }),
		]
		if (declaration.forkable) {
			for (const forkId of forkIdsByDefinition.get(pluginDefinitionIndexKey(declaration.address)) ??
				[]) {
				consumers.push(
					Object.freeze({
						definition: declaration.address,
						variant: 'fork' as const,
						forkId,
					}),
				)
			}
		}
		for (const consumer of consumers) {
			const required = new Set(declaration.requires.map(pluginDefinitionIndexKey))
			for (const requirement of declaration.requires) {
				edges.push(
					projectRequiredEdge({
						consumer,
						requirement,
						override: overrides.get(edgeIdentityKey(consumer, requirement)),
						direct: view.catalog.byDefinition.has(pluginDefinitionIndexKey(requirement)),
						providerDefault: providerDefaults.get(pluginDefinitionIndexKey(requirement)),
						effectiveAdjacency: requiredAdjacency,
					}),
				)
			}
			for (const requirement of declaration.optional) {
				if (required.has(pluginDefinitionIndexKey(requirement))) continue
				const provider = defaultNodeAddress(requirement)
				edges.push(
					Object.freeze({
						consumer: cloneNodeAddress(consumer),
						requirement: cloneDefinitionAddress(requirement),
						mode: 'optional' as const,
						resolution: Object.freeze({
							state: 'resolved' as const,
							provider: cloneNodeAddress(provider),
							via: 'direct' as const,
						}),
						effective: optionalAdjacency.has(adjacencyKey(consumer, provider)),
					}),
				)
			}
		}
	}
	edges.sort(compareEdges)
	assertSameAdjacency(requiredAdjacency, projectedEffectiveAdjacency(edges, 'required'), 'required')
	assertSameAdjacency(optionalAdjacency, projectedEffectiveAdjacency(edges, 'optional'), 'optional')
	validateProjectedGraph(nodesByKey, edges)
	return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) })
}

function projectRequiredEdge(input: {
	consumer: PluginNodeAddress
	requirement: PluginDefinitionAddress
	override: PluginNodeAddress | undefined
	direct: boolean
	providerDefault: PluginNodeAddress | undefined
	effectiveAdjacency: ReadonlySet<string>
}): PluginDependencyGraphEdge {
	const resolved = input.override
		? { provider: input.override, via: 'dependency-override' as const }
		: input.direct
			? { provider: defaultNodeAddress(input.requirement), via: 'direct' as const }
			: input.providerDefault
				? { provider: input.providerDefault, via: 'provider-default' as const }
				: undefined
	if (!resolved) {
		return Object.freeze({
			consumer: cloneNodeAddress(input.consumer),
			requirement: cloneDefinitionAddress(input.requirement),
			mode: 'required' as const,
			resolution: Object.freeze({ state: 'unresolved' as const }),
			effective: false as const,
		})
	}
	return Object.freeze({
		consumer: cloneNodeAddress(input.consumer),
		requirement: cloneDefinitionAddress(input.requirement),
		mode: 'required' as const,
		resolution: Object.freeze({
			state: 'resolved' as const,
			provider: cloneNodeAddress(resolved.provider),
			via: resolved.via,
		}),
		effective: input.effectiveAdjacency.has(adjacencyKey(input.consumer, resolved.provider)),
	})
}

function freezePluginStatus(entry: PluginCatalogProjectionEntry): PluginStatusSnapshot {
	const { nodeKey: _nodeKey, execution, recentUpdate, issues, label, address, ...status } = entry
	return Object.freeze({
		...status,
		address: cloneNodeAddress(address),
		label: Object.freeze({ ...label }),
		issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
		execution: clonePluginExecutionSnapshot(execution),
		recentUpdate:
			recentUpdate === null ? null : clonePluginRecentUpdateSnapshot(recentUpdate),
	})
}

function validateProjectedGraph(
	nodesByKey: ReadonlyMap<string, PluginDependencyGraphNode>,
	edges: readonly PluginDependencyGraphEdge[],
): void {
	const identities = new Set<string>()
	const outgoing = new Map<string, string[]>()
	const indegree = new Map<string, number>()
	for (const [key, node] of nodesByKey) if (node.effective) indegree.set(key, 0)
	for (const edge of edges) {
		const identity = edgeIdentityKey(edge.consumer, edge.requirement)
		if (identities.has(identity)) {
			throw new Error('[runtime:dependency-graph] duplicate consumer requirement edge')
		}
		identities.add(identity)
		const consumer = nodesByKey.get(pluginNodeIndexKey(edge.consumer))
		if (!consumer) throw new Error('[runtime:dependency-graph] edge consumer is absent')
		if (edge.resolution.state === 'unresolved') {
			if (edge.effective) throw new Error('[runtime:dependency-graph] unresolved edge is effective')
			continue
		}
		const provider = nodesByKey.get(pluginNodeIndexKey(edge.resolution.provider))
		if (!provider && edge.mode === 'required') {
			throw new Error('[runtime:dependency-graph] required provider status is absent')
		}
		if (!edge.effective) continue
		if (!consumer.effective || !provider?.effective) {
			throw new Error('[runtime:dependency-graph] effective edge endpoint is inactive')
		}
		const providerKey = pluginNodeIndexKey(edge.resolution.provider)
		const consumerKey = pluginNodeIndexKey(edge.consumer)
		const consumers = outgoing.get(providerKey) ?? []
		consumers.push(consumerKey)
		outgoing.set(providerKey, consumers)
		indegree.set(consumerKey, (indegree.get(consumerKey) ?? 0) + 1)
	}
	const queue = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key)
	let visited = 0
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const provider = queue[cursor]!
		visited++
		for (const consumer of outgoing.get(provider) ?? []) {
			const next = indegree.get(consumer)! - 1
			indegree.set(consumer, next)
			if (next === 0) queue.push(consumer)
		}
	}
	if (visited !== indegree.size) {
		throw new Error('[runtime:dependency-graph] effective dependency graph is cyclic')
	}
}

function assertSameNodeMembership(left: ReadonlySet<string>, right: ReadonlySet<string>): void {
	if (left.size === right.size && [...left].every((key) => right.has(key))) return
	throw new Error('[runtime:dependency-graph] Runtime and Core committed node membership diverged')
}

function projectedEffectiveAdjacency(
	edges: readonly PluginDependencyGraphEdge[],
	mode: PluginDependencyGraphEdge['mode'],
): Set<string> {
	const adjacency = new Set<string>()
	for (const edge of edges) {
		if (!edge.effective || edge.mode !== mode || edge.resolution.state !== 'resolved') continue
		adjacency.add(adjacencyKey(edge.consumer, edge.resolution.provider))
	}
	return adjacency
}

function assertSameAdjacency(
	core: ReadonlySet<string>,
	projected: ReadonlySet<string>,
	mode: PluginDependencyGraphEdge['mode'],
): void {
	if (core.size === projected.size && [...core].every((key) => projected.has(key))) return
	throw new Error(`[runtime:dependency-graph] Core and projected ${mode} adjacency diverged`)
}

function adjacencyIndex(edges: readonly CorePluginDependencyAdjacencyEdge[]): Set<string> {
	return new Set(edges.map((edge) => adjacencyKey(edge.consumer, edge.provider)))
}

function adjacencyKey(consumer: PluginNodeAddress, provider: PluginNodeAddress): string {
	return `${pluginNodeIndexKey(consumer)}:${pluginNodeIndexKey(provider)}`
}

function edgeIdentityKey(
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): string {
	return `${pluginNodeIndexKey(consumer)}:${pluginDefinitionIndexKey(requirement)}`
}

function compareEdges(left: PluginDependencyGraphEdge, right: PluginDependencyGraphEdge): number {
	return (
		comparePluginNodeAddress(left.consumer, right.consumer) ||
		comparePluginDefinitionAddress(left.requirement, right.requirement)
	)
}

function defaultNodeAddress(definition: PluginDefinitionAddress): PluginNodeAddress {
	return Object.freeze({ definition, variant: 'default' })
}

function cloneDefinitionAddress(address: PluginDefinitionAddress): PluginDefinitionAddress {
	const entry =
		address.entry.kind === 'package-root'
			? Object.freeze({ kind: 'package-root' as const, packageName: address.entry.packageName })
			: Object.freeze({
					kind: 'source-entry' as const,
					sourceSpace: address.entry.sourceSpace,
					path: address.entry.path,
				})
	return Object.freeze({ entry, exportName: address.exportName })
}

function cloneNodeAddress(address: PluginNodeAddress): PluginNodeAddress {
	const definition = cloneDefinitionAddress(address.definition)
	return address.variant === 'default'
		? Object.freeze({ definition, variant: 'default' as const })
		: Object.freeze({ definition, variant: 'fork' as const, forkId: address.forkId })
}
