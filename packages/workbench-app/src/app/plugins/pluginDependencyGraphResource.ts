import { pluginNodeIndexKey } from '@pluxel/core'
import type {
	PluginDependencyGraphEdge,
	PluginDependencyGraphNode,
	PluginDependencyGraphSnapshot,
	RuntimeManagementClient,
} from '@pluxel/runtime/web'

const PLUGIN_DEPENDENCY_GRAPH_TTL = 30_000

export type PluginDependencyGraphProjection = Readonly<{
	snapshot: PluginDependencyGraphSnapshot
	byNode: ReadonlyMap<string, PluginDependencyGraphNode>
	outgoing: ReadonlyMap<string, readonly PluginDependencyGraphEdge[]>
	incoming: ReadonlyMap<string, readonly PluginDependencyGraphEdge[]>
}>

export type PluginDependencyGraphResourceSnapshot = Readonly<{
	graph: PluginDependencyGraphProjection | null
	isLoading: boolean
	isStale: boolean
	error?: string
}>

const EMPTY_RESOURCE_SNAPSHOT: PluginDependencyGraphResourceSnapshot = Object.freeze({
	graph: null,
	isLoading: false,
	isStale: false,
})

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

export class PluginDependencyGraphResource {
	private snapshot: PluginDependencyGraphResourceSnapshot = EMPTY_RESOURCE_SNAPSHOT
	private readonly listeners = new Set<() => void>()
	private inflight: Promise<void> | null = null
	private inflightVersion = -1
	private invalidationVersion = 0
	private loadedVersion = -1
	private loadedAt = 0

	constructor(
		private readonly client: RuntimeManagementClient,
		private readonly now: () => number = Date.now,
	) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly getSnapshot = (): PluginDependencyGraphResourceSnapshot => this.snapshot

	load(force = false): Promise<void> {
		if (this.inflight !== null) {
			if (!force || this.inflightVersion >= this.invalidationVersion) return this.inflight
			const requiredVersion = this.invalidationVersion
			return this.inflight.then(() => {
				if (
					!this.snapshot.isStale &&
					this.invalidationVersion === requiredVersion &&
					this.loadedVersion >= requiredVersion
				) {
					return undefined
				}
				return this.load(true)
			})
		}
		if (
			!force &&
			!this.snapshot.isStale &&
			this.snapshot.graph &&
			this.now() - this.loadedAt < PLUGIN_DEPENDENCY_GRAPH_TTL
		) {
			return Promise.resolve()
		}

		this.publish(
			Object.freeze({
				graph: this.snapshot.graph,
				isLoading: true,
				isStale: this.snapshot.isStale,
			}),
		)
		const readVersion = this.invalidationVersion
		this.inflightVersion = readVersion
		const task = this.client.dependencies
			.graph()
			.then((snapshot): undefined => {
				this.loadedAt = this.now()
				this.loadedVersion = readVersion
				this.publish(
					Object.freeze({
						graph: buildPluginDependencyGraphProjection(snapshot),
						isLoading: false,
						isStale: readVersion !== this.invalidationVersion,
					}),
				)
				return undefined
			})
			.catch((error: unknown): void => {
				this.publish(
					Object.freeze({
						graph: this.snapshot.graph,
						isLoading: false,
						isStale: this.snapshot.graph !== null,
						error: errorMessage(error, '无法读取插件依赖图'),
					}),
				)
			})
			.finally(() => {
				if (this.inflight === task) this.inflight = null
			})
		this.inflight = task
		return task
	}

	markStale(): void {
		this.invalidationVersion += 1
		this.loadedAt = 0
		this.publish(
			Object.freeze({
				graph: this.snapshot.graph,
				isLoading: this.snapshot.isLoading,
				isStale: true,
				...(this.snapshot.error === undefined ? {} : { error: this.snapshot.error }),
			}),
		)
		if (this.listeners.size > 0) void this.load(true)
	}

	private publish(snapshot: PluginDependencyGraphResourceSnapshot): void {
		this.snapshot = snapshot
		for (const listener of this.listeners) listener()
	}
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

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
