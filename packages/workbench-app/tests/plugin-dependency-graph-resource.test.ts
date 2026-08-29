import {
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type {
	PluginDependencyGraphSnapshot,
	PluginStatusSnapshot,
	RuntimeManagementClient,
} from '@pluxel/runtime/web'
import { describe, expect, it, vi } from 'vitest'
import {
	buildPluginDependencyGraphProjection,
	PluginDependencyGraphResource,
} from '../src/app/plugins/pluginDependencyGraphResource'

const provider = node('ProviderPlugin')
const consumer = node('ConsumerPlugin')
const missing = definition('MissingPlugin')

const graph = Object.freeze({
	nodes: Object.freeze([
		Object.freeze({ status: status(provider), effective: true }),
		Object.freeze({ status: status(consumer), effective: true }),
	]),
	edges: Object.freeze([
		Object.freeze({
			consumer,
			requirement: provider.definition,
			mode: 'required' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider,
				via: 'direct' as const,
			}),
			effective: true,
		}),
		Object.freeze({
			consumer,
			requirement: missing,
			mode: 'required' as const,
			resolution: Object.freeze({ state: 'unresolved' as const }),
			effective: false as const,
		}),
	]),
}) satisfies PluginDependencyGraphSnapshot

describe('plugin dependency graph resource', () => {
	it('builds canonical node, outgoing, and incoming indices once per snapshot', () => {
		const projected = buildPluginDependencyGraphProjection(graph)

		expect(projected.snapshot).toBe(graph)
		expect(projected.byNode.get(pluginNodeIndexKey(provider))?.status.address).toEqual(provider)
		expect(projected.outgoing.get(pluginNodeIndexKey(consumer))).toEqual(graph.edges)
		expect(projected.incoming.get(pluginNodeIndexKey(provider))).toEqual([graph.edges[0]])
		expect(projected.incoming.has(pluginNodeIndexKey(consumer))).toBe(false)
		expect(Object.isFrozen(projected)).toBe(true)
		expect(Object.isFrozen(projected.outgoing.get(pluginNodeIndexKey(consumer)))).toBe(true)
	})

	it('deduplicates reads, honors TTL, and reloads after explicit invalidation', async () => {
		let now = 1_000
		let release!: (value: PluginDependencyGraphSnapshot) => void
		const firstRead = new Promise<PluginDependencyGraphSnapshot>((resolve) => {
			release = resolve
		})
		const graphRead = vi.fn(() => firstRead)
		const resource = new PluginDependencyGraphResource(client(graphRead), () => now)

		const first = resource.load()
		const duplicate = resource.load()
		expect(duplicate).toBe(first)
		expect(resource.getSnapshot()).toMatchObject({ isLoading: true, isStale: false })
		release(graph)
		await first
		expect(graphRead).toHaveBeenCalledTimes(1)

		now += 10_000
		await resource.load()
		expect(graphRead).toHaveBeenCalledTimes(1)

		resource.markStale()
		expect(resource.getSnapshot()).toMatchObject({
			graph: expect.any(Object),
			isLoading: false,
			isStale: true,
		})
		graphRead.mockResolvedValueOnce(graph)
		await resource.load()
		expect(graphRead).toHaveBeenCalledTimes(2)
		expect(resource.getSnapshot()).toMatchObject({ isLoading: false, isStale: false })
	})

	it('keeps last-known-good data visible when a refresh fails', async () => {
		const graphRead = vi.fn<() => Promise<PluginDependencyGraphSnapshot>>()
		graphRead.mockResolvedValueOnce(graph).mockRejectedValueOnce(new Error('offline'))
		const resource = new PluginDependencyGraphResource(client(graphRead))

		await resource.load()
		const lastGood = resource.getSnapshot().graph
		await resource.load(true)

		expect(resource.getSnapshot()).toEqual({
			graph: lastGood,
			isLoading: false,
			isStale: true,
			error: 'offline',
		})
	})

	it('does not let an old in-flight read clear a mutation invalidation', async () => {
		let release!: (value: PluginDependencyGraphSnapshot) => void
		const oldRead = new Promise<PluginDependencyGraphSnapshot>((resolve) => {
			release = resolve
		})
		const committedAfterMutation = Object.freeze({
			nodes: graph.nodes,
			edges: graph.edges,
		}) satisfies PluginDependencyGraphSnapshot
		const graphRead = vi
			.fn<() => Promise<PluginDependencyGraphSnapshot>>()
			.mockReturnValueOnce(oldRead)
			.mockResolvedValueOnce(committedAfterMutation)
		const resource = new PluginDependencyGraphResource(client(graphRead))
		const observed: Array<{ isStale: boolean; snapshot?: PluginDependencyGraphSnapshot }> = []
		const unsubscribe = resource.subscribe(() => {
			const current = resource.getSnapshot()
			observed.push({
				isStale: current.isStale,
				...(current.graph ? { snapshot: current.graph.snapshot } : {}),
			})
		})

		void resource.load()
		resource.markStale()
		const refreshed = resource.load(true)
		release(graph)
		await refreshed
		unsubscribe()

		expect(graphRead).toHaveBeenCalledTimes(2)
		expect(observed).toContainEqual({ isStale: true, snapshot: graph })
		expect(resource.getSnapshot()).toMatchObject({ isLoading: false, isStale: false })
		expect(resource.getSnapshot().graph?.snapshot).toBe(committedAfterMutation)
	})

	it('still runs the post-invalidation read when the old request rejects without data', async () => {
		let rejectOld!: (reason: Error) => void
		const oldRead = new Promise<PluginDependencyGraphSnapshot>((_resolve, reject) => {
			rejectOld = reject
		})
		const graphRead = vi
			.fn<() => Promise<PluginDependencyGraphSnapshot>>()
			.mockReturnValueOnce(oldRead)
			.mockResolvedValueOnce(graph)
		const resource = new PluginDependencyGraphResource(client(graphRead))
		const unsubscribe = resource.subscribe(() => undefined)

		void resource.load()
		resource.markStale()
		const refreshed = resource.load(true)
		rejectOld(new Error('old request failed'))
		await refreshed
		unsubscribe()

		expect(graphRead).toHaveBeenCalledTimes(2)
		expect(resource.getSnapshot()).toMatchObject({
			graph: expect.any(Object),
			isLoading: false,
			isStale: false,
		})
	})
})

function definition(exportName: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: '@fixture/dependency-graph' },
		exportName,
	}
}

function node(exportName: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'default' }
}

function status(address: PluginNodeAddress): PluginStatusSnapshot {
	const name = address.definition.exportName
	return {
		address,
		reference: `package:@fixture/dependency-graph::${name}`,
		route: `v1/package/${name}/@fixture/dependency-graph`,
		displayName: name,
		label: { title: name, text: name },
		rootExportName: name,
		autoStart: true,
		sessionIntent: 'inherit',
		desiredState: 'running',
		activationReason: 'auto-start',
		lifecycleState: 'running',
		availability: 'available',
		issues: [],
		source: {
			kind: 'unknown',
			moduleId: null,
			packageName: null,
			version: null,
			tag: null,
		},
	}
}

function client(graphRead: () => Promise<PluginDependencyGraphSnapshot>): RuntimeManagementClient {
	return {
		dependencies: { graph: graphRead },
	} as unknown as RuntimeManagementClient
}
