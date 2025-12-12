// commitPlanner.ts
// Pure graph/diff utilities for PluginService.commit().
// This module is intentionally side‑effect free so it stays easy to reason about
// and can be inlined by the bundler. Keep hot‑path logic allocation‑light.

import type { ServiceMap } from '../../container'
import type { BasePlugin } from '../BasePlugin'
import type { PluginIdentifier } from '../types'

export type InitPlan = {
	batches: PluginIdentifier[][]
	leftovers: Set<PluginIdentifier>
	dependencies: Map<PluginIdentifier, readonly PluginIdentifier[]>
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
		const deps = raw.length ? raw.map(resolve) : raw
		dependencies.set(id, deps)
		for (const dep of deps) {
			if (!inDegree.has(dep)) continue
			inDegree.set(id, inDegree.get(id)! + 1)
			graph.get(dep)!.push(id)
		}
	}

	const batches: PluginIdentifier[][] = []
	let frontier: PluginIdentifier[] = []
	for (const [id, degree] of inDegree) {
		if (degree === 0) frontier.push(id)
	}

	while (frontier.length) {
		batches.push(frontier)
		const next: PluginIdentifier[] = []
		for (const current of frontier) {
			for (const dependent of graph.get(current)!) {
				const remaining = inDegree.get(dependent)! - 1
				inDegree.set(dependent, remaining)
				if (remaining === 0) next.push(dependent)
			}
		}
		frontier = next
	}

	const leftovers = new Set<PluginIdentifier>()
	for (const [id, degree] of inDegree) {
		if (degree > 0) leftovers.add(id)
	}

	return { batches, leftovers, dependencies }
}

export function planTeardown(
	dependents: ReadonlyMap<PluginIdentifier, Set<PluginIdentifier>> | undefined,
	affected: Set<PluginIdentifier>,
): PluginIdentifier[] {
	if (!dependents || affected.size === 0) return []

	const remainingChildren = new Map<PluginIdentifier, number>()
	const parents = new Map<PluginIdentifier, PluginIdentifier[]>()

	for (const id of affected) {
		remainingChildren.set(id, 0)
		parents.set(id, [])
	}

	for (const id of affected) {
		const children = dependents.get(id)
		if (!children) continue
		for (const child of children) {
			if (!affected.has(child)) continue
			remainingChildren.set(id, (remainingChildren.get(id) ?? 0) + 1)
			parents.get(child)!.push(id)
		}
	}

	const order: PluginIdentifier[] = []
	const stack: PluginIdentifier[] = []
	for (const [id, count] of remainingChildren) {
		if (count === 0) stack.push(id)
	}

	while (stack.length) {
		const current = stack.pop()!
		order.push(current)
		for (const parent of parents.get(current)!) {
			const next = (remainingChildren.get(parent) ?? 0) - 1
			remainingChildren.set(parent, next)
			if (next === 0) stack.push(parent)
		}
	}

	for (const [id, count] of remainingChildren) {
		if (count > 0) order.push(id)
	}
	return order
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
