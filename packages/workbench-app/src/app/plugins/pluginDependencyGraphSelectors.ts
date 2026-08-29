import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { PluginDependencyGraphEdge, PluginDependencyGraphNode } from '@pluxel/runtime/web'
import type { PluginDependencyGraphProjection } from './pluginDependencyGraphResource'

export type RequiredPluginDependencyEdge = Extract<PluginDependencyGraphEdge, { mode: 'required' }>
export type OptionalPluginDependencyEdge = Extract<PluginDependencyGraphEdge, { mode: 'optional' }>

export type PluginDependencyEndpoint =
	| Readonly<{
			state: 'status'
			node: PluginDependencyGraphNode
	  }>
	| Readonly<{
			state: 'absent'
			address: PluginNodeAddress
	  }>

export type RequiredPluginDependency = Readonly<{
	edge: RequiredPluginDependencyEdge
	provider: PluginDependencyEndpoint | null
}>

export type OptionalPluginIntegration = Readonly<{
	edge: OptionalPluginDependencyEdge
	provider: PluginDependencyEndpoint
}>

export type PluginDependent = Readonly<{
	edge: PluginDependencyGraphEdge
	consumer: PluginDependencyGraphNode
}>

export type PluginDependencyDetail = Readonly<{
	node: PluginDependencyGraphNode | null
	required: readonly RequiredPluginDependency[]
	optional: readonly OptionalPluginIntegration[]
	dependents: Readonly<{
		effective: readonly PluginDependent[]
		inactive: readonly PluginDependent[]
	}>
}>

export function selectPluginDependencyDetail(
	graph: PluginDependencyGraphProjection,
	owner: PluginNodeAddress,
): PluginDependencyDetail {
	const ownerKey = pluginNodeIndexKey(owner)
	const required: RequiredPluginDependency[] = []
	const optional: OptionalPluginIntegration[] = []

	for (const edge of graph.outgoing.get(ownerKey) ?? []) {
		if (edge.mode === 'required') {
			required.push(
				Object.freeze({
					edge,
					provider:
						edge.resolution.state === 'resolved'
							? selectEndpoint(graph, edge.resolution.provider)
							: null,
				}),
			)
			continue
		}

		optional.push(
			Object.freeze({
				edge,
				provider: selectEndpoint(graph, edge.resolution.provider),
			}),
		)
	}

	const effective: PluginDependent[] = []
	const inactive: PluginDependent[] = []
	for (const edge of graph.incoming.get(ownerKey) ?? []) {
		const consumer = graph.byNode.get(pluginNodeIndexKey(edge.consumer))
		if (!consumer) continue
		const dependent = Object.freeze({ edge, consumer })
		if (edge.effective) effective.push(dependent)
		else inactive.push(dependent)
	}

	return Object.freeze({
		node: graph.byNode.get(ownerKey) ?? null,
		required: Object.freeze(required),
		optional: Object.freeze(optional),
		dependents: Object.freeze({
			effective: Object.freeze(effective),
			inactive: Object.freeze(inactive),
		}),
	})
}

function selectEndpoint(
	graph: PluginDependencyGraphProjection,
	address: PluginNodeAddress,
): PluginDependencyEndpoint {
	const node = graph.byNode.get(pluginNodeIndexKey(address))
	return node
		? Object.freeze({ state: 'status', node })
		: Object.freeze({ state: 'absent', address })
}
