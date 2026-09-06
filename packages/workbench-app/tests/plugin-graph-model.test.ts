import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type {
	PluginDependencyGraphEdge,
	PluginDependencyGraphSnapshot,
	PluginStatusSnapshot,
} from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import { buildPluginDependencyGraphProjection } from '../src/app/plugins/pluginDependencyGraphModel'
import {
	buildPluginGraphVisualModel,
	describePluginGraphNode,
	pluginGraphSelectionKey,
	pluginGraphPluginNodeId,
	rebasePluginGraphSelection,
} from '../src/app/plugin-graph/pluginGraphModel'
import {
	clearPluginGraphLayoutCacheForTests,
	layoutPluginGraph,
} from '../src/app/plugin-graph/pluginGraphLayout'

const provider = node('ProviderPlugin')
const consumer = node('ConsumerPlugin')
const isolated = node('IsolatedPlugin')
const inactiveA = node('InactiveA')
const inactiveB = node('InactiveB')
const absentOptional = node('AbsentOptional')
const unresolved = definition('UnresolvedRequirement')

describe('plugin graph visual model', () => {
	it('projects provider-to-consumer effective edges and retains isolated effective nodes', () => {
		const model = buildPluginGraphVisualModel(projection(snapshot()), 'effective', 'all')

		expect(model.nodes.map((item) => item.id)).toContain(pluginGraphPluginNodeId(isolated))
		expect(model.isolatedNodes.map((item) => item.id)).toEqual([pluginGraphPluginNodeId(isolated)])
		expect(model.connectedNodes.map((item) => item.id)).toEqual(
			expect.arrayContaining([
				pluginGraphPluginNodeId(provider),
				pluginGraphPluginNodeId(consumer),
			]),
		)
		expect(model.components).toHaveLength(1)
		expect(model.nodes.every((item) => item.kind === 'plugin' && item.effective)).toBe(true)
		expect(model.edges).toHaveLength(1)
		expect(model.edges[0]).toMatchObject({
			source: pluginGraphPluginNodeId(provider),
			target: pluginGraphPluginNodeId(consumer),
			mode: 'required',
			effective: true,
		})
		expect(model.incomingById.get(pluginGraphPluginNodeId(consumer))).toEqual(model.edges)
		expect(model.outgoingById.get(pluginGraphPluginNodeId(provider))).toEqual(model.edges)
	})

	it('adds namespaced hollow placeholders only to declaration relations', () => {
		const model = buildPluginGraphVisualModel(projection(snapshot()), 'declaration', 'all')

		expect(model.nodes.filter((item) => item.kind === 'plugin')).toHaveLength(5)
		expect(model.nodes.filter((item) => item.kind === 'absent-provider')).toHaveLength(1)
		expect(model.nodes.filter((item) => item.kind === 'unresolved-requirement')).toHaveLength(1)
		expect(model.nodes.map((item) => item.id)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^plugin:/),
				expect.stringMatching(/^absent-provider:/),
				expect.stringMatching(/^unresolved-requirement:/),
			]),
		)
		expect(model.edges).toHaveLength(5)
	})

	it('filters edge modes without dropping status nodes', () => {
		const graph = projection(snapshot())
		const required = buildPluginGraphVisualModel(graph, 'declaration', 'required')
		const optional = buildPluginGraphVisualModel(graph, 'declaration', 'optional')

		expect(required.nodes.filter((item) => item.kind === 'plugin')).toHaveLength(5)
		expect(optional.nodes.filter((item) => item.kind === 'plugin')).toHaveLength(5)
		expect(required.edges.every((item) => item.mode === 'required')).toBe(true)
		expect(optional.edges.every((item) => item.mode === 'optional')).toBe(true)
	})

	it('keeps auto-start policy independent from observed lifecycle state', () => {
		const model = buildPluginGraphVisualModel(
			projection(snapshot({ providerAutoStart: false })),
			'effective',
			'all',
		)
		const visual = model.byId.get(pluginGraphPluginNodeId(provider))
		expect(visual?.kind).toBe('plugin')
		if (!visual || visual.kind !== 'plugin') throw new Error('expected provider node')

		expect(describePluginGraphNode(visual)).toMatchObject({
			state: 'running',
			stateLabel: '运行中',
			policyLabel: '本次会话启动',
		})
	})

	it('lays out a latent declaration cycle deterministically and reuses pure-status layout', () => {
		clearPluginGraphLayoutCacheForTests()
		const firstModel = buildPluginGraphVisualModel(projection(snapshot()), 'declaration', 'all')
		const firstLayout = layoutPluginGraph(firstModel)
		const statusOnlyRefresh = snapshot({ providerRunning: false })
		const secondModel = buildPluginGraphVisualModel(
			projection(statusOnlyRefresh),
			'declaration',
			'all',
		)
		const secondLayout = layoutPluginGraph(secondModel)
		const withAnotherIsolate = snapshot()
		const thirdModel = buildPluginGraphVisualModel(
			projection(
				Object.freeze({
					...withAnotherIsolate,
					nodes: Object.freeze([
						...withAnotherIsolate.nodes,
						Object.freeze({ status: status(node('AnotherIsolate')), effective: true }),
					]),
				}),
			),
			'declaration',
			'all',
		)
		const thirdLayout = layoutPluginGraph(thirdModel)
		clearPluginGraphLayoutCacheForTests()
		const recomputedLayout = layoutPluginGraph(firstModel)

		expect(secondModel.topologyKey).toBe(firstModel.topologyKey)
		expect(secondLayout).toBe(firstLayout)
		expect(thirdModel.topologyKey).toBe(firstModel.topologyKey)
		expect(thirdLayout).toBe(firstLayout)
		expect(recomputedLayout).not.toBe(firstLayout)
		expect([...recomputedLayout.positions]).toEqual([...firstLayout.positions])
		expect(firstLayout.positions.has(pluginGraphPluginNodeId(isolated))).toBe(false)
		expect(firstLayout.components).toHaveLength(firstModel.components.length)
		expect(new Set(firstLayout.components.map((component) => component.x)).size).toBe(2)
		expect(new Set(firstLayout.components.map((component) => component.y)).size).toBe(1)
		expect(firstLayout.edges.size).toBe(firstModel.edges.length)
		expect(
			[...firstLayout.positions.values()].every(
				(position) => Number.isFinite(position.x) && Number.isFinite(position.y),
			),
		).toBe(true)
	})

	it('rebases manual selection by stable ID after refresh and clears missing selections', () => {
		const firstModel = buildPluginGraphVisualModel(projection(snapshot()), 'declaration', 'all')
		const providerId = pluginGraphPluginNodeId(provider)
		const firstProvider = firstModel.byId.get(providerId)
		expect(firstProvider?.kind).toBe('plugin')
		if (!firstProvider) throw new Error('expected provider node')
		const selectionKey = pluginGraphSelectionKey({ kind: 'node', node: firstProvider })

		const refreshedModel = buildPluginGraphVisualModel(
			projection(snapshot({ providerRunning: false })),
			'declaration',
			'all',
		)
		const refreshed = rebasePluginGraphSelection(refreshedModel, selectionKey, null)
		expect(refreshed.manualSelectionKey).toBe(selectionKey)
		expect(refreshed.selection?.kind).toBe('node')
		if (refreshed.selection?.kind !== 'node' || refreshed.selection.node.kind !== 'plugin') {
			throw new Error('expected refreshed provider selection')
		}
		expect(refreshed.selection.node).not.toBe(firstProvider)
		expect(refreshed.selection.node.node.status.lifecycleState).toBe('stopped')

		const filteredModel = buildPluginGraphVisualModel(projection(snapshot()), 'effective', 'all')
		const inactive = firstModel.byId.get(pluginGraphPluginNodeId(inactiveA))
		expect(inactive).toBeDefined()
		if (!inactive) throw new Error('expected inactive node')
		const missing = rebasePluginGraphSelection(
			filteredModel,
			pluginGraphSelectionKey({ kind: 'node', node: inactive }),
			null,
		)
		expect(missing).toEqual({ manualSelectionKey: null, selection: null })
	})

	it('keeps explicit close closed while undefined manual selection follows route focus', () => {
		const model = buildPluginGraphVisualModel(projection(snapshot()), 'effective', 'all')
		const routeNode = model.byId.get(pluginGraphPluginNodeId(provider))
		expect(routeNode).toBeDefined()
		if (!routeNode) throw new Error('expected route node')
		const routeSelection = Object.freeze({ kind: 'node' as const, node: routeNode })

		expect(rebasePluginGraphSelection(model, undefined, routeSelection)).toEqual({
			manualSelectionKey: undefined,
			selection: routeSelection,
		})
		expect(rebasePluginGraphSelection(model, null, routeSelection)).toEqual({
			manualSelectionKey: null,
			selection: null,
		})
	})
})

function projection(value: PluginDependencyGraphSnapshot) {
	return buildPluginDependencyGraphProjection(value)
}

function snapshot(
	options: { providerRunning?: boolean; providerAutoStart?: boolean } = {},
): PluginDependencyGraphSnapshot {
	const edges: PluginDependencyGraphEdge[] = [
		resolvedEdge(consumer, provider, 'required', true),
		resolvedEdge(consumer, absentOptional, 'optional', false),
		{
			consumer,
			requirement: unresolved,
			mode: 'required',
			resolution: { state: 'unresolved' },
			effective: false,
		},
		resolvedEdge(inactiveA, inactiveB, 'required', false),
		resolvedEdge(inactiveB, inactiveA, 'required', false),
	]
	return Object.freeze({
		nodes: Object.freeze([
			Object.freeze({ status: status(consumer), effective: true }),
			Object.freeze({ status: status(inactiveA, false, false), effective: false }),
			Object.freeze({ status: status(inactiveB, false, false), effective: false }),
			Object.freeze({ status: status(isolated), effective: true }),
			Object.freeze({
				status: status(
					provider,
					options.providerRunning ?? true,
					options.providerAutoStart ?? true,
				),
				effective: true,
			}),
		]),
		edges: Object.freeze(edges),
	})
}

function resolvedEdge(
	consumerAddress: PluginNodeAddress,
	providerAddress: PluginNodeAddress,
	mode: 'required' | 'optional',
	effective: boolean,
): PluginDependencyGraphEdge {
	return mode === 'optional'
		? {
				consumer: consumerAddress,
				requirement: providerAddress.definition,
				mode,
				resolution: { state: 'resolved', provider: providerAddress, via: 'direct' },
				effective,
			}
		: {
				consumer: consumerAddress,
				requirement: providerAddress.definition,
				mode,
				resolution: { state: 'resolved', provider: providerAddress, via: 'direct' },
				effective,
			}
}

function definition(exportName: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: '@fixture/plugin-graph' },
		exportName,
	}
}

function node(exportName: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'default' }
}

function status(
	address: PluginNodeAddress,
	running = true,
	autoStart = true,
): PluginStatusSnapshot {
	const name = address.definition.exportName
	return {
		address,
		reference: `package:@fixture/plugin-graph::${name}`,
		route: `v1/package/${name}/@fixture/plugin-graph`,
		displayName: name,
		label: { title: name, text: name },
		rootExportName: name,
		autoStart,
		sessionIntent: running && !autoStart ? 'run' : 'inherit',
		desiredState: running || autoStart ? 'running' : 'stopped',
		activationReason: autoStart ? 'auto-start' : running ? 'session' : null,
		lifecycleState: running ? 'running' : 'stopped',
		availability: 'available',
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
	}
}
