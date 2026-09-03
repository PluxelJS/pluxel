import { pluginNodeIndexKey } from '@pluxel/core'
import type {
	PluginDependencyGraphEdge,
	PluginDependencyGraphNode,
	PluginDependencyGraphSnapshot,
} from '@pluxel/runtime/web'

export type PluginDependencyGraphProjection = Readonly<{
	snapshot: PluginDependencyGraphSnapshot
	byNode: ReadonlyMap<string, PluginDependencyGraphNode>
	outgoing: ReadonlyMap<string, readonly PluginDependencyGraphEdge[]>
	incoming: ReadonlyMap<string, readonly PluginDependencyGraphEdge[]>
}>

export function buildPluginDependencyGraphProjection(
	snapshot: PluginDependencyGraphSnapshot,
): PluginDependencyGraphProjection {
	const byNode = new Map<string, PluginDependencyGraphNode>()
	const outgoing = new Map<string, PluginDependencyGraphEdge[]>()
	const incoming = new Map<string, PluginDependencyGraphEdge[]>()

	for (const node of snapshot.nodes) {
		byNode.set(pluginNodeIndexKey(node.status.address), node)
	}
	for (const edge of snapshot.edges) {
		appendEdge(outgoing, pluginNodeIndexKey(edge.consumer), edge)
		if (edge.resolution.state === 'resolved') {
			appendEdge(incoming, pluginNodeIndexKey(edge.resolution.provider), edge)
		}
	}

	return Object.freeze({
		snapshot,
		byNode,
		outgoing: freezeEdgeIndex(outgoing),
		incoming: freezeEdgeIndex(incoming),
	})
}

function appendEdge(
	index: Map<string, PluginDependencyGraphEdge[]>,
	key: string,
	edge: PluginDependencyGraphEdge,
): void {
	const edges = index.get(key)
	if (edges) edges.push(edge)
	else index.set(key, [edge])
}

function freezeEdgeIndex(
	index: Map<string, PluginDependencyGraphEdge[]>,
): ReadonlyMap<string, readonly PluginDependencyGraphEdge[]> {
	return new Map([...index].map(([key, edges]) => [key, Object.freeze(edges)] as const))
}
