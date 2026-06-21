// commit.ts
// Pure graph/diff utilities and scheduling strategies used by PluginService.commit().
//
// Goal: keep PluginService readable while avoiding scattering across many tiny files.
// Everything here is intentionally side-effect free.

/* ─────────────────────────── Init Plan ─────────────────────────── */

export type InitPlan<T> = {
	/**
	 * Topological "levels" (aka depth batches).
	 * Level boundaries are useful for legacy batching, but the same graph can also
	 * be scheduled via a ready-queue without barriers.
	 */
	levels: T[][]
	/** All planned nodes (excludes leftovers/cycles). */
	nodes: T[]
	leftovers: Set<T>
	/** Resolved dependency list for each node (may include deps outside `nodes`). */
	dependencies: Map<T, readonly T[]>
	/** Adjacency within `nodes`: dep -> dependents. */
	graph: Map<T, T[]>
	/** Initial in-degree within `nodes`. */
	inDegree: Map<T, number>
}

export function computeInitPlan<T>(
	plugins: Iterable<T>,
	getDependencies: (id: T) => readonly T[],
): InitPlan<T> {
	const inDegree = new Map<T, number>()
	const graph = new Map<T, T[]>()
	const dependencies = new Map<T, readonly T[]>()

	for (const id of plugins) {
		inDegree.set(id, 0)
		graph.set(id, [])
	}

	for (const id of inDegree.keys()) {
		const deps = getDependencies(id)
		dependencies.set(id, deps)
		for (const dep of deps) {
			if (!inDegree.has(dep)) continue
			inDegree.set(id, inDegree.get(id)! + 1)
			graph.get(dep)!.push(id)
		}
	}

	// Copy, because we'll mutate for level computation but also expose initial inDegree for schedulers.
	const remaining = new Map(inDegree)

	const levels: T[][] = []
	let frontier: T[] = []
	for (const [id, degree] of remaining) {
		if (degree === 0) frontier.push(id)
	}

	while (frontier.length > 0) {
		levels.push(frontier)
		const next: T[] = []
		for (const current of frontier) {
			for (const dependent of graph.get(current)!) {
				const nextRemaining = remaining.get(dependent)! - 1
				remaining.set(dependent, nextRemaining)
				if (nextRemaining === 0) next.push(dependent)
			}
		}
		frontier = next
	}

	const leftovers = new Set<T>()
	for (const [id, degree] of remaining) {
		if (degree > 0) leftovers.add(id)
	}

	// Expose nodes excluding cycles, so schedulers never need to flatten levels.
	const plannedNodes: T[] = []
	for (let i = 0; i < levels.length; i++) {
		const level = levels[i]!
		for (let j = 0; j < level.length; j++) plannedNodes.push(level[j]!)
	}

	// Prune graph/inDegree to only planned nodes. This avoids wasted scheduler work on leftovers.
	const nodeSet = new Set(plannedNodes)
	const plannedInDegree = new Map<T, number>()
	const plannedGraph = new Map<T, T[]>()
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
			const next: T[] = []
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

export async function startPluginsWithStrategy<T>(
	plan: InitPlan<T>,
	instantiateAndStart: (id: T) => Promise<boolean>,
	opts: StartStrategyOptions = {},
): Promise<Set<T>> {
	const failed = new Set<T>(plan.leftovers)
	if (plan.nodes.length === 1 && failed.size === 0) {
		const id = plan.nodes[0]!
		const deps = plan.dependencies.get(id) ?? []
		if (deps.length === 0) {
			const ok = await instantiateAndStart(id)
			if (!ok) failed.add(id)
			return failed
		}
	}

	const strategy = opts.strategy ?? 'ready-queue'
	if (strategy === 'batch') {
		await startPluginsBatched(plan, instantiateAndStart, failed)
		return failed
	}

	const concurrency = normalizeConcurrency(opts.concurrency, 8)
	await startPluginsReadyQueue(plan, instantiateAndStart, failed, concurrency)
	return failed
}

async function startPluginsBatched<T>(
	plan: InitPlan<T>,
	instantiateAndStart: (id: T) => Promise<boolean>,
	failed: Set<T>,
): Promise<void> {
	const { dependencies } = plan

	for (const batch of plan.levels) {
		let single: Promise<void> | undefined
		let tasks: Promise<void>[] | undefined
		for (const id of batch) {
			if (failed.has(id)) continue

			const deps = dependencies.get(id)
			if (deps && deps.length > 0) {
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

			const p = instantiateAndStart(id).then((ok): undefined => {
				if (!ok) failed.add(id)
				return undefined
			})
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

async function startPluginsReadyQueue<T>(
	plan: InitPlan<T>,
	instantiateAndStart: (id: T) => Promise<boolean>,
	failed: Set<T>,
	concurrency: number,
): Promise<void> {
	const nodes = plan.nodes
	if (nodes.length === 0) return

	// inDegree counts only edges within this plan; safe to mutate.
	const remainingDeps = new Map(plan.inDegree)
	const dependents = plan.graph
	const hasFailedDep = new Set<T>()
	const blocked: T[] = []
	let blockedHead = 0
	const blockedQueued = new Set<T>()
	const ready: T[] = []
	let readyHead = 0
	const inFlight = new Set<Promise<void>>()

	for (let i = 0; i < nodes.length; i++) {
		const id = nodes[i]!
		if (nodeDependsOnFailedSeed(id, plan.dependencies, failed)) {
			markBlockedNode(id, hasFailedDep, blockedQueued, blocked)
		}
		if ((remainingDeps.get(id) ?? 0) === 0) ready.push(id)
	}

	const complete = (id: T, ok: boolean) => {
		const children = dependents.get(id)
		if (!children) return
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!
			const next = (remainingDeps.get(child) ?? 0) - 1
			remainingDeps.set(child, next)
			if (!ok) {
				markBlockedNode(child, hasFailedDep, blockedQueued, blocked)
			}
			if (next === 0) ready.push(child)
		}
	}

	const failAndPropagate = (id: T) => {
		if (failed.has(id)) return
		failed.add(id)
		complete(id, false)
	}

	const schedule = (id: T) => {
		const p = (async () => {
			try {
				const ok = await instantiateAndStart(id)
				if (!ok) failed.add(id)
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

	while (readyHead < ready.length || blockedHead < blocked.length || inFlight.size > 0) {
		while (blockedHead < blocked.length) {
			const id = blocked[blockedHead++]!
			failAndPropagate(id)
		}

		while (readyHead < ready.length && inFlight.size < concurrency) {
			const id = ready[readyHead++]!
			if (failed.has(id)) continue
			if (hasFailedDep.has(id)) continue
			schedule(id)
		}

		if (inFlight.size > 0) await Promise.race(inFlight)
	}
}

function nodeDependsOnFailedSeed<T>(
	id: T,
	dependencies: ReadonlyMap<T, readonly T[]>,
	failed: ReadonlySet<T>,
): boolean {
	const deps = dependencies.get(id) ?? []
	for (let i = 0; i < deps.length; i++) {
		if (failed.has(deps[i]!)) return true
	}
	return false
}

function markBlockedNode<T>(
	id: T,
	hasFailedDep: Set<T>,
	blockedQueued: Set<T>,
	blocked: T[],
): void {
	hasFailedDep.add(id)
	if (blockedQueued.has(id)) return
	blockedQueued.add(id)
	blocked.push(id)
}

/* ─────────────────────────── Teardown Strategy ─────────────────────────── */

export type TeardownStrategyOptions = {
	/**
	 * Bounded concurrency for stopping independent subtrees.
	 * Default is 1 to preserve legacy "sequential stop" behavior.
	 */
	concurrency?: number
}

export async function stopPluginsTopo<T>(
	getDependents: ((id: T) => Iterable<T>) | undefined,
	affected: Set<T>,
	stop: (id: T) => Promise<void>,
	opts: TeardownStrategyOptions = {},
): Promise<void> {
	if (!getDependents || affected.size === 0) return
	if (affected.size === 1) {
		for (const id of affected) {
			await stop(id).catch(() => {
				// stop is best-effort by design; keep teardown progressing.
			})
		}
		return
	}

	const concurrency = normalizeConcurrency(opts.concurrency, 1)

	// Reverse-topo scheduler:
	// - a node becomes "ready to stop" once all of its affected dependents are stopped.
	// - default concurrency=1 preserves deterministic sequential teardown.
	const remainingChildren = new Map<T, number>()
	const parents = new Map<T, T[]>()

	for (const id of affected) {
		remainingChildren.set(id, 0)
		parents.set(id, [])
	}

	for (const id of affected) {
		const children = getDependents(id)
		for (const child of children) {
			if (!affected.has(child)) continue
			remainingChildren.set(id, (remainingChildren.get(id) ?? 0) + 1)
			parents.get(child)!.push(id)
		}
	}

	const ready: T[] = []
	for (const [id, count] of remainingChildren) {
		if (count === 0) ready.push(id)
	}

	const stopped = new Set<T>()
	let head = 0
	const inFlight = new Set<Promise<void>>()

	const complete = (id: T) => {
		for (const parent of parents.get(id)!) {
			const next = (remainingChildren.get(parent) ?? 0) - 1
			remainingChildren.set(parent, next)
			if (next === 0) ready.push(parent)
		}
	}

	const schedule = (id: T) => {
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

	while (head < ready.length || inFlight.size > 0) {
		while (head < ready.length && inFlight.size < concurrency) {
			const id = ready[head++]!
			if (stopped.has(id)) continue
			schedule(id)
		}

		if (inFlight.size > 0) {
			await Promise.race(inFlight)
			continue
		}

		// Cycle: break it by stopping remaining nodes in any order.
		for (const id of affected) {
			if (!stopped.has(id)) ready.push(id)
		}
	}
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
	if (value === null || value === undefined) return fallback
	if (!Number.isFinite(value)) return fallback
	const n = Math.floor(value)
	return n >= 1 ? n : 1
}
