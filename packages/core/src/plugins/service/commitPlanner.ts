// commitPlanner.ts
// Pure graph/diff utilities for PluginService.commit().
// This module is intentionally side‑effect free so it stays easy to reason about
// and can be inlined by the bundler. Keep hot‑path logic allocation‑light.

import type { ServiceMap } from '../../container'
import type { BasePlugin } from '../BasePlugin'
import type { PluginIdentifier } from '../types'

export type InitPlan = {
	/**
	 * Topological "levels" (aka depth batches).
	 * Level boundaries are useful for legacy batching, but the same graph can also
	 * be scheduled via a ready-queue without barriers.
	 */
	levels: PluginIdentifier[][]
	/** All planned nodes (excludes leftovers/cycles). */
	nodes: PluginIdentifier[]
	leftovers: Set<PluginIdentifier>
	/** Resolved dependency list for each node (may include deps outside `nodes`). */
	dependencies: Map<PluginIdentifier, readonly PluginIdentifier[]>
	/** Adjacency within `nodes`: dep -> dependents. */
	graph: Map<PluginIdentifier, PluginIdentifier[]>
	/** Initial in-degree within `nodes`. */
	inDegree: Map<PluginIdentifier, number>
}

export function computeInitPlan(
	plugins: ServiceMap<BasePlugin>,
	resolve: (id: PluginIdentifier) => PluginIdentifier = (id) => id,
): InitPlan {
	const inDegree = new Map<PluginIdentifier, number>()
	const graph = new Map<PluginIdentifier, PluginIdentifier[]>()
	const dependencies = new Map<PluginIdentifier, readonly PluginIdentifier[]>()

	for (const id of plugins.keys()) {
		inDegree.set(id, 0)
		graph.set(id, [])
	}

	for (const [id, plugin] of plugins) {
		const raw = (plugin.dependencies ?? []) as PluginIdentifier[]
		let deps = raw
		if (raw.length) {
			const next = new Array<PluginIdentifier>(raw.length)
			for (let i = 0; i < raw.length; i++) next[i] = resolve(raw[i])
			deps = next
		}
		dependencies.set(id, deps)
		for (const dep of deps) {
			if (!inDegree.has(dep)) continue
			inDegree.set(id, inDegree.get(id)! + 1)
			graph.get(dep)!.push(id)
		}
	}

	// Copy, because we'll mutate for level computation but also expose initial inDegree for schedulers.
	const remaining = new Map(inDegree)

	const levels: PluginIdentifier[][] = []
	let frontier: PluginIdentifier[] = []
	for (const [id, degree] of remaining) {
		if (degree === 0) frontier.push(id)
	}

	while (frontier.length) {
		levels.push(frontier)
		const next: PluginIdentifier[] = []
		for (const current of frontier) {
			for (const dependent of graph.get(current)!) {
				const nextRemaining = remaining.get(dependent)! - 1
				remaining.set(dependent, nextRemaining)
				if (nextRemaining === 0) next.push(dependent)
			}
		}
		frontier = next
	}

	const leftovers = new Set<PluginIdentifier>()
	for (const [id, degree] of remaining) {
		if (degree > 0) leftovers.add(id)
	}

	// Expose nodes excluding cycles, so schedulers never need to flatten levels.
	const plannedNodes: PluginIdentifier[] = []
	for (let i = 0; i < levels.length; i++) {
		const level = levels[i]!
		for (let j = 0; j < level.length; j++) plannedNodes.push(level[j]!)
	}

	// Prune graph/inDegree to only planned nodes. This avoids wasted scheduler work on leftovers.
	const nodeSet = new Set(plannedNodes)
	const plannedInDegree = new Map<PluginIdentifier, number>()
	const plannedGraph = new Map<PluginIdentifier, PluginIdentifier[]>()
	for (let i = 0; i < plannedNodes.length; i++) {
		const id = plannedNodes[i]!
		plannedInDegree.set(id, inDegree.get(id) ?? 0)
		const children = graph.get(id) ?? []
		if (children.length === 0) {
			plannedGraph.set(id, [])
			continue
		}
		// Filter dependents to planned-only.
		let keepAll = true
		for (let j = 0; j < children.length; j++) {
			if (!nodeSet.has(children[j]!)) {
				keepAll = false
				break
			}
		}
		if (keepAll) plannedGraph.set(id, children)
		else {
			const next: PluginIdentifier[] = []
			for (let j = 0; j < children.length; j++) {
				const child = children[j]!
				if (nodeSet.has(child)) next.push(child)
			}
			plannedGraph.set(id, next)
		}
	}

	return {
		levels,
		nodes: plannedNodes,
		leftovers,
		dependencies,
		graph: plannedGraph,
		inDegree: plannedInDegree,
	}
}

export function partitionChanges(changes: Array<{ type: string; key: unknown }>) {
	const added = new Set<PluginIdentifier>()
	const replaced = new Set<PluginIdentifier>()
	const removed = new Set<PluginIdentifier>()

	for (const { type, key } of changes) {
		const id = key as PluginIdentifier
		if (type === 'add') added.add(id)
		else if (type === 'replace') replaced.add(id)
		else removed.add(id)
	}

	return { added, replaced, removed }
}
