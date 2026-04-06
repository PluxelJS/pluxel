// commit.ts
// Pure graph/diff utilities and scheduling strategies used by PluginService.commit().
//
// Goal: keep PluginService readable while avoiding scattering across many tiny files.
// Everything here is intentionally side-effect free.

import type { ServiceMap } from '../../container'
import type { BasePlugin } from '../composition/BasePlugin'
import type { PluginIdentifier } from '../types'

/* ─────────────────────────── Init Plan ─────────────────────────── */

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
			const next = Array<PluginIdentifier>(raw.length)
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

/* ─────────────────────────── Startup Strategy ─────────────────────────── */

export type PluginStartStrategy = 'ready-queue' | 'batch'

export type StartStrategyOptions = {
	/**
	 * - `ready-queue`: bounded-concurrency topo scheduler (no batch barriers).
	 * - `batch`: legacy "group by depth + Promise.all per batch".
	 */
	strategy?: PluginStartStrategy
	/** Only used by `ready-queue`. Minimum is 1. */
	concurrency?: number
}

export async function startPluginsWithStrategy(
	plan: InitPlan,
	instantiateAndStart: (id: PluginIdentifier, failed: Set<PluginIdentifier>) => Promise<void>,
	opts: StartStrategyOptions = {},
): Promise<Set<PluginIdentifier>> {
	const failed = new Set<PluginIdentifier>(plan.leftovers)

	const strategy = opts.strategy ?? 'ready-queue'
	if (strategy === 'batch') {
		await startPluginsBatched(plan, instantiateAndStart, failed)
		return failed
	}

	const concurrency = normalizeStartConcurrency(opts.concurrency)
	await startPluginsReadyQueue(plan, instantiateAndStart, failed, concurrency)
	return failed
}

async function startPluginsBatched(
	plan: InitPlan,
	instantiateAndStart: (id: PluginIdentifier, failed: Set<PluginIdentifier>) => Promise<void>,
	failed: Set<PluginIdentifier>,
): Promise<void> {
	const { dependencies } = plan

	for (const batch of plan.levels) {
		let single: Promise<void> | undefined
		let tasks: Promise<void>[] | undefined
		for (const id of batch) {
			if (failed.has(id)) continue

			const deps = dependencies.get(id)
			if (deps && deps.length) {
				let blocked = false
				for (let i = 0; i < deps.length; i++) {
					if (failed.has(deps[i])) {
						blocked = true
						break
					}
				}
				if (blocked) {
					failed.add(id)
					continue
				}
			}

			const p = instantiateAndStart(id, failed)
			if (!single) single = p
			else {
				tasks ??= [single]
				tasks.push(p)
			}
		}

		if (tasks) await Promise.all(tasks)
		else if (single) await single
	}
}

async function startPluginsReadyQueue(
	plan: InitPlan,
	instantiateAndStart: (id: PluginIdentifier, failed: Set<PluginIdentifier>) => Promise<void>,
	failed: Set<PluginIdentifier>,
	concurrency: number,
): Promise<void> {
	const nodes = plan.nodes
	if (nodes.length === 0) return

	// inDegree counts only edges within this plan; safe to mutate.
	const remainingDeps = new Map(plan.inDegree)
	const dependents = plan.graph
	const hasFailedDep = new Set<PluginIdentifier>()
	const blocked: PluginIdentifier[] = []
	let blockedHead = 0
	const blockedQueued = new Set<PluginIdentifier>()

	// Track already-failed upstream and "external" deps (outside this plan).
	for (let i = 0; i < nodes.length; i++) {
		const id = nodes[i]!
		const deps = plan.dependencies.get(id) ?? []
		for (let j = 0; j < deps.length; j++) {
			const dep = deps[j]!
			if (failed.has(dep)) {
				hasFailedDep.add(id)
				if (!blockedQueued.has(id)) {
					blockedQueued.add(id)
					blocked.push(id)
				}
				break
			}
		}
	}

	const ready: PluginIdentifier[] = []
	for (let i = 0; i < nodes.length; i++) {
		const id = nodes[i]!
		if ((remainingDeps.get(id) ?? 0) === 0) ready.push(id)
	}

	let head = 0
	const inFlight = new Set<Promise<void>>()

	const complete = (id: PluginIdentifier, ok: boolean) => {
		const children = dependents.get(id)
		if (!children) return
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!
			const next = (remainingDeps.get(child) ?? 0) - 1
			remainingDeps.set(child, next)
			if (!ok) {
				hasFailedDep.add(child)
				if (!failed.has(child) && !blockedQueued.has(child)) {
					blockedQueued.add(child)
					blocked.push(child)
				}
			}
			if (next === 0) ready.push(child)
		}
	}

	const failAndPropagate = (id: PluginIdentifier) => {
		if (failed.has(id)) return
		failed.add(id)
		complete(id, false)
	}

	const schedule = (id: PluginIdentifier) => {
		const p = (async () => {
			try {
				await instantiateAndStart(id, failed)
			} catch {
				// Defensive: instantiateAndStart shouldn't throw, but keep scheduler stable.
				failed.add(id)
			}
			complete(id, !failed.has(id))
		})().finally(() => {
			inFlight.delete(p)
		})
		inFlight.add(p)
	}

	while (head < ready.length || blockedHead < blocked.length || inFlight.size) {
		while (blockedHead < blocked.length) {
			const id = blocked[blockedHead++]!
			failAndPropagate(id)
		}

		while (head < ready.length && inFlight.size < concurrency) {
			const id = ready[head++]!
			if (failed.has(id)) continue
			if (hasFailedDep.has(id)) continue
			schedule(id)
		}

		if (inFlight.size) await Promise.race(inFlight)
	}
}

function normalizeStartConcurrency(value: number | undefined): number {
	if (value == null) return 8
	if (!Number.isFinite(value)) return 8
	const n = Math.floor(value)
	return n >= 1 ? n : 1
}

/* ─────────────────────────── Teardown Strategy ─────────────────────────── */

export type TeardownStrategyOptions = {
	/**
	 * Bounded concurrency for stopping independent subtrees.
	 * Default is 1 to preserve legacy "sequential stop" behavior.
	 */
	concurrency?: number
}

export async function stopPluginsTopo(
	dependents: ReadonlyMap<PluginIdentifier, Set<PluginIdentifier>> | undefined,
	affected: Set<PluginIdentifier>,
	stop: (id: PluginIdentifier) => Promise<void>,
	opts: TeardownStrategyOptions = {},
): Promise<void> {
	if (!dependents || affected.size === 0) return

	const concurrency = normalizeStopConcurrency(opts.concurrency, 1)

	// Reverse-topo scheduler:
	// - a node becomes "ready to stop" once all of its affected dependents are stopped.
	// - default concurrency=1 preserves deterministic sequential teardown.
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

	const ready: PluginIdentifier[] = []
	for (const [id, count] of remainingChildren) {
		if (count === 0) ready.push(id)
	}

	const stopped = new Set<PluginIdentifier>()
	let head = 0
	const inFlight = new Set<Promise<void>>()

	const complete = (id: PluginIdentifier) => {
		for (const parent of parents.get(id)!) {
			const next = (remainingChildren.get(parent) ?? 0) - 1
			remainingChildren.set(parent, next)
			if (next === 0) ready.push(parent)
		}
	}

	const schedule = (id: PluginIdentifier) => {
		stopped.add(id)
		const p = stop(id)
			.catch(() => {
				// stop is best-effort by design; keep teardown progressing.
			})
			.then(() => complete(id))
			.finally(() => {
				inFlight.delete(p)
			})
		inFlight.add(p)
	}

	while (head < ready.length || inFlight.size) {
		while (head < ready.length && inFlight.size < concurrency) {
			const id = ready[head++]!
			if (stopped.has(id)) continue
			schedule(id)
		}

		if (inFlight.size) {
			await Promise.race(inFlight)
			continue
		}

		// Cycle: break it by stopping remaining nodes in any order.
		for (const id of affected) {
			if (!stopped.has(id)) ready.push(id)
		}
	}
}

function normalizeStopConcurrency(value: number | undefined, fallback: number): number {
	if (value == null) return fallback
	if (!Number.isFinite(value)) return fallback
	const n = Math.floor(value)
	return n >= 1 ? n : 1
}
