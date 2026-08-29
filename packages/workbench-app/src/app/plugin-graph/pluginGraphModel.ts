import {
	formatPluginDefinitionReference,
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginDependencyGraphEdge, PluginDependencyGraphNode } from '@pluxel/runtime/web'
import type { PluginDependencyGraphProjection } from '../plugins/pluginDependencyGraphResource'
import type { PluginGraphFocus } from './pluginGraphRoute'

export type PluginGraphView = 'effective' | 'declaration'
export type PluginGraphModeFilter = 'all' | 'required' | 'optional'

export type PluginGraphVisualNode =
	| Readonly<{
			id: string
			kind: 'plugin'
			address: PluginNodeAddress
			label: string
			qualifier?: string
			reference: string
			effective: boolean
			node: PluginDependencyGraphNode
	  }>
	| Readonly<{
			id: string
			kind: 'absent-provider'
			address: PluginNodeAddress
			label: string
			qualifier?: never
			reference: string
			effective: false
	  }>
	| Readonly<{
			id: string
			kind: 'unresolved-requirement'
			requirement: PluginDefinitionAddress
			label: string
			qualifier?: never
			reference: string
			effective: false
	  }>

export type PluginGraphVisualEdge = Readonly<{
	id: string
	source: string
	target: string
	mode: PluginDependencyGraphEdge['mode']
	effective: boolean
	edge: PluginDependencyGraphEdge
}>

export type PluginGraphComponent = Readonly<{
	id: string
	nodes: readonly PluginGraphVisualNode[]
	edges: readonly PluginGraphVisualEdge[]
}>

export type PluginGraphVisualModel = Readonly<{
	view: PluginGraphView
	mode: PluginGraphModeFilter
	nodes: readonly PluginGraphVisualNode[]
	edges: readonly PluginGraphVisualEdge[]
	connectedNodes: readonly PluginGraphVisualNode[]
	isolatedNodes: readonly PluginGraphVisualNode[]
	components: readonly PluginGraphComponent[]
	byId: ReadonlyMap<string, PluginGraphVisualNode>
	edgeById: ReadonlyMap<string, PluginGraphVisualEdge>
	incomingById: ReadonlyMap<string, readonly PluginGraphVisualEdge[]>
	outgoingById: ReadonlyMap<string, readonly PluginGraphVisualEdge[]>
	searchTextById: ReadonlyMap<string, string>
	topologyKey: string
}>

export type PluginGraphSelection =
	| Readonly<{ kind: 'node'; node: PluginGraphVisualNode }>
	| Readonly<{ kind: 'edge'; edge: PluginGraphVisualEdge }>

export type PluginGraphSelectionKey =
	| Readonly<{ kind: 'node'; id: string }>
	| Readonly<{ kind: 'edge'; id: string }>

export type ManualPluginGraphSelection = PluginGraphSelectionKey | null | undefined

export type RebasedPluginGraphSelection = Readonly<{
	manualSelectionKey: ManualPluginGraphSelection
	selection: PluginGraphSelection | null
}>

export type PluginGraphNodePresentation = Readonly<{
	state: 'running' | 'attention' | 'stopped' | 'unavailable' | 'missing'
	stateLabel: string
	policyLabel: string | null
	priority: number
}>

export function pluginGraphPluginNodeId(address: PluginNodeAddress): string {
	return `plugin:${pluginNodeIndexKey(address)}`
}

export function pluginGraphEdgeId(
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): string {
	return `edge:${pluginNodeIndexKey(consumer)}:${pluginDefinitionIndexKey(requirement)}`
}

function absentProviderNodeId(address: PluginNodeAddress): string {
	return `absent-provider:${pluginNodeIndexKey(address)}`
}

function unresolvedRequirementNodeId(requirement: PluginDefinitionAddress): string {
	return `unresolved-requirement:${pluginDefinitionIndexKey(requirement)}`
}

export function buildPluginGraphVisualModel(
	graph: PluginDependencyGraphProjection,
	view: PluginGraphView,
	mode: PluginGraphModeFilter,
): PluginGraphVisualModel {
	const nodes: PluginGraphVisualNode[] = []
	const edges: PluginGraphVisualEdge[] = []
	const byId = new Map<string, PluginGraphVisualNode>()
	const edgeById = new Map<string, PluginGraphVisualEdge>()

	for (const node of graph.snapshot.nodes) {
		if (view === 'effective' && !node.effective) continue
		const visualNode = Object.freeze({
			id: pluginGraphPluginNodeId(node.status.address),
			kind: 'plugin' as const,
			address: node.status.address,
			label: node.status.label.title || node.status.label.text,
			...(node.status.label.qualifier ? { qualifier: node.status.label.qualifier } : {}),
			reference: node.status.reference,
			effective: node.effective,
			node,
		})
		nodes.push(visualNode)
		byId.set(visualNode.id, visualNode)
	}

	for (const edge of graph.snapshot.edges) {
		if (mode !== 'all' && edge.mode !== mode) continue
		if (view === 'effective' && !edge.effective) continue

		const consumerId = pluginGraphPluginNodeId(edge.consumer)
		if (!byId.has(consumerId)) continue
		let providerId: string
		if (edge.resolution.state === 'unresolved') {
			if (view === 'effective') continue
			providerId = unresolvedRequirementNodeId(edge.requirement)
			if (!byId.has(providerId)) {
				const reference = formatPluginDefinitionReference(edge.requirement)
				const placeholder = Object.freeze({
					id: providerId,
					kind: 'unresolved-requirement' as const,
					requirement: edge.requirement,
					label: edge.requirement.exportName,
					reference,
					effective: false as const,
				})
				nodes.push(placeholder)
				byId.set(providerId, placeholder)
			}
		} else {
			providerId = pluginGraphPluginNodeId(edge.resolution.provider)
			if (!byId.has(providerId)) {
				if (view === 'effective') continue
				providerId = absentProviderNodeId(edge.resolution.provider)
				if (!byId.has(providerId)) {
					const reference = formatPluginNodeReference(edge.resolution.provider)
					const placeholder = Object.freeze({
						id: providerId,
						kind: 'absent-provider' as const,
						address: edge.resolution.provider,
						label: edge.resolution.provider.definition.exportName,
						reference,
						effective: false as const,
					})
					nodes.push(placeholder)
					byId.set(providerId, placeholder)
				}
			}
		}

		const visualEdge = Object.freeze({
			id: pluginGraphEdgeId(edge.consumer, edge.requirement),
			source: providerId,
			target: consumerId,
			mode: edge.mode,
			effective: edge.effective,
			edge,
		})
		edges.push(visualEdge)
		edgeById.set(visualEdge.id, visualEdge)
	}

	const incomingById = buildEdgeIndex(edges, (edge) => edge.target)
	const outgoingById = buildEdgeIndex(edges, (edge) => edge.source)
	const connectedNodeIds = new Set<string>()
	for (const edge of edges) {
		connectedNodeIds.add(edge.source)
		connectedNodeIds.add(edge.target)
	}
	const connectedNodes = Object.freeze(nodes.filter((node) => connectedNodeIds.has(node.id)))
	const isolatedNodes = Object.freeze(nodes.filter((node) => !connectedNodeIds.has(node.id)))
	const components = buildConnectedComponents(connectedNodes, edges)
	const searchTextById = new Map(
		nodes.map(
			(node) =>
				[
					node.id,
					normalizeSearchText(`${node.label}\n${node.qualifier ?? ''}\n${node.reference}`),
				] as const,
		),
	)
	const topologyKey = buildTopologyKey(view, mode, connectedNodes, edges)
	return Object.freeze({
		view,
		mode,
		nodes: Object.freeze(nodes),
		edges: Object.freeze(edges),
		connectedNodes,
		isolatedNodes,
		components,
		byId,
		edgeById,
		incomingById,
		outgoingById,
		searchTextById,
		topologyKey,
	})
}

/**
 * Projects the five independent runtime control facts into one primary visual state plus one
 * secondary activation-policy label. In particular, autoStart-off is never treated as disabled.
 */
export function describePluginGraphNode(
	visual: PluginGraphVisualNode,
): PluginGraphNodePresentation {
	if (visual.kind === 'absent-provider') {
		return Object.freeze({
			state: 'missing',
			stateLabel: '提供方缺失',
			policyLabel: null,
			priority: 0,
		})
	}
	if (visual.kind === 'unresolved-requirement') {
		return Object.freeze({
			state: 'missing',
			stateLabel: '依赖未解析',
			policyLabel: null,
			priority: 0,
		})
	}

	const status = visual.node.status
	if (status.availability !== 'available') {
		return Object.freeze({
			state: 'unavailable',
			stateLabel: '当前不可用',
			policyLabel: status.autoStart ? '自动启动已开启' : '按需启动',
			priority: 0,
		})
	}

	const policyLabel =
		status.activationReason === 'dependency'
			? '由依赖激活'
			: status.activationReason === 'session'
				? '本次会话启动'
				: status.activationReason === 'auto-start' || status.autoStart
					? '自动启动'
					: '按需启动'
	if (status.lifecycleState === 'running') {
		return Object.freeze({
			state: 'running',
			stateLabel: '运行中',
			policyLabel,
			priority: status.issues.length > 0 ? 0 : 3,
		})
	}
	if (status.desiredState === 'running') {
		return Object.freeze({
			state: 'attention',
			stateLabel: '等待运行',
			policyLabel,
			priority: 0,
		})
	}
	return Object.freeze({
		state: 'stopped',
		stateLabel: '已停止',
		policyLabel: status.autoStart ? '自动启动已开启' : '按需启动',
		priority: status.issues.length > 0 ? 0 : 2,
	})
}

export function resolvePluginGraphFocus(
	model: PluginGraphVisualModel,
	focus: PluginGraphFocus | null,
): PluginGraphSelection | null {
	if (!focus) return null
	if (focus.kind === 'node') {
		const node = model.byId.get(pluginGraphPluginNodeId(focus.address))
		return node ? Object.freeze({ kind: 'node', node }) : null
	}
	const edge = model.edgeById.get(pluginGraphEdgeId(focus.consumer, focus.requirement))
	return edge ? Object.freeze({ kind: 'edge', edge }) : null
}

export function pluginGraphSelectionKey(
	selection: PluginGraphSelection | null,
): PluginGraphSelectionKey | null {
	if (!selection) return null
	return selection.kind === 'node'
		? Object.freeze({ kind: 'node', id: selection.node.id })
		: Object.freeze({ kind: 'edge', id: selection.edge.id })
}

export function rebasePluginGraphSelection(
	model: PluginGraphVisualModel,
	manualSelectionKey: ManualPluginGraphSelection,
	routeSelection: PluginGraphSelection | null,
): RebasedPluginGraphSelection {
	if (manualSelectionKey === undefined) {
		return Object.freeze({ manualSelectionKey, selection: routeSelection })
	}
	if (manualSelectionKey === null) {
		return Object.freeze({ manualSelectionKey, selection: null })
	}

	const selection = resolvePluginGraphSelectionKey(model, manualSelectionKey)
	return Object.freeze({
		manualSelectionKey: selection ? manualSelectionKey : null,
		selection,
	})
}

export function searchPluginGraphNodes(
	model: PluginGraphVisualModel,
	query: string,
): readonly PluginGraphVisualNode[] {
	const normalized = normalizeSearchText(query)
	if (!normalized) return model.nodes
	return Object.freeze(
		model.nodes.filter((node) => model.searchTextById.get(node.id)?.includes(normalized)),
	)
}

function buildTopologyKey(
	view: PluginGraphView,
	mode: PluginGraphModeFilter,
	nodes: readonly PluginGraphVisualNode[],
	edges: readonly PluginGraphVisualEdge[],
): string {
	return [
		view,
		mode,
		...nodes.map((node) => `n:${node.id}`),
		...edges.map(
			(edge) =>
				`e:${edge.id}:${edge.source}:${edge.target}:${edge.mode}:${edge.edge.resolution.state}`,
		),
	].join('|')
}

function buildEdgeIndex(
	edges: readonly PluginGraphVisualEdge[],
	keyOf: (edge: PluginGraphVisualEdge) => string,
): ReadonlyMap<string, readonly PluginGraphVisualEdge[]> {
	const index = new Map<string, PluginGraphVisualEdge[]>()
	for (const edge of edges) {
		const key = keyOf(edge)
		const current = index.get(key)
		if (current) current.push(edge)
		else index.set(key, [edge])
	}
	return new Map([...index].map(([key, value]) => [key, Object.freeze(value)] as const))
}

function buildConnectedComponents(
	nodes: readonly PluginGraphVisualNode[],
	edges: readonly PluginGraphVisualEdge[],
): readonly PluginGraphComponent[] {
	const adjacency = new Map<string, Set<string>>()
	for (const node of nodes) adjacency.set(node.id, new Set())
	for (const edge of edges) {
		adjacency.get(edge.source)?.add(edge.target)
		adjacency.get(edge.target)?.add(edge.source)
	}

	const components: PluginGraphComponent[] = []
	const visited = new Set<string>()
	for (const seed of nodes) {
		if (visited.has(seed.id)) continue
		const memberIds = new Set<string>()
		const pending = [seed.id]
		visited.add(seed.id)
		while (pending.length > 0) {
			const id = pending.pop()
			if (!id) continue
			memberIds.add(id)
			for (const adjacentId of adjacency.get(id) ?? []) {
				if (visited.has(adjacentId)) continue
				visited.add(adjacentId)
				pending.push(adjacentId)
			}
		}
		const componentNodes = Object.freeze(nodes.filter((node) => memberIds.has(node.id)))
		const componentEdges = Object.freeze(
			edges.filter((edge) => memberIds.has(edge.source) && memberIds.has(edge.target)),
		)
		components.push(
			Object.freeze({
				id: `component:${componentNodes[0]?.id ?? components.length}`,
				nodes: componentNodes,
				edges: componentEdges,
			}),
		)
	}
	return Object.freeze(components)
}

function normalizeSearchText(value: string): string {
	return value.trim().toLocaleLowerCase()
}

function resolvePluginGraphSelectionKey(
	model: PluginGraphVisualModel,
	selection: PluginGraphSelectionKey,
): PluginGraphSelection | null {
	if (selection.kind === 'node') {
		const node = model.byId.get(selection.id)
		return node ? Object.freeze({ kind: 'node', node }) : null
	}
	const edge = model.edgeById.get(selection.id)
	return edge ? Object.freeze({ kind: 'edge', edge }) : null
}
