// commit.ts
// Pure graph/diff utilities and lifecycle scheduling used by PluginService.commit().
//
// Goal: keep PluginService readable while avoiding scattering across many tiny files.
// Everything here is intentionally side-effect free.

/* ─────────────────────────── Init Plan ─────────────────────────── */

export type InitPlan<T> = {
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

	// Copy because topological planning mutates degrees while the scheduler needs the originals.
	const remaining = new Map(inDegree)

	let frontier: T[] = []
	const plannedNodes: T[] = []
	for (const [id, degree] of remaining) {
		if (degree === 0) frontier.push(id)
	}

	while (frontier.length > 0) {
		const next: T[] = []
		for (const current of frontier) {
			plannedNodes.push(current)
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
		nodes: plannedNodes,
		leftovers,
		dependencies,
		graph: plannedGraph,
		inDegree: plannedInDegree,
	}
}

/* ─────────────────────────── Startup Scheduler ─────────────────────────── */

export type StartOptions = {
	concurrency?: number
	/** Whether a failed dependency blocks the consumer. Optional ordering edges return false. */
	blocks?: (id: unknown, dependency: unknown) => boolean
	/** Called when a node is skipped because one of its dependencies failed. */
	onDependencyBlocked?: (id: unknown, dependency: unknown) => void
}

export async function startPluginsTopo<T>(
	plan: InitPlan<T>,
	instantiateAndStart: (id: T) => Promise<boolean>,
	opts: StartOptions = {},
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

	const concurrency = normalizeConcurrency(opts.concurrency, 8)
	await startPluginsReadyQueue(
		plan,
		instantiateAndStart,
		failed,
		concurrency,
		opts.onDependencyBlocked,
		opts.blocks,
	)
	return failed
}

async function startPluginsReadyQueue<T>(
	plan: InitPlan<T>,
	instantiateAndStart: (id: T) => Promise<boolean>,
	failed: Set<T>,
	concurrency: number,
	onDependencyBlocked?: (id: T, dependency: T) => void,
	blocks: (id: T, dependency: T) => boolean = () => true,
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
		const blocker = failedDependencyOf(id, plan.dependencies, failed, blocks)
		if (blocker !== undefined) {
			markBlockedNode(id, hasFailedDep, blockedQueued, blocked)
			onDependencyBlocked?.(id, blocker)
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
			if (!ok && blocks(child, id)) {
				markBlockedNode(child, hasFailedDep, blockedQueued, blocked)
				onDependencyBlocked?.(child, id)
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

function failedDependencyOf<T>(
	id: T,
	dependencies: ReadonlyMap<T, readonly T[]>,
	failed: ReadonlySet<T>,
	blocks: (id: T, dependency: T) => boolean,
): T | undefined {
	const deps = dependencies.get(id) ?? []
	for (let i = 0; i < deps.length; i++) {
		const dep = deps[i]!
		if (failed.has(dep) && blocks(id, dep)) return dep
	}
	return undefined
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
			try {
				await stop(id)
			} catch {
				// stop is best-effort by design; keep teardown progressing.
			}
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

	const complete = (id: T) => {
		for (const parent of parents.get(id)!) {
			const next = (remainingChildren.get(parent) ?? 0) - 1
			remainingChildren.set(parent, next)
			if (next === 0) ready.push(parent)
		}
	}

	if (concurrency === 1) {
		while (stopped.size < affected.size) {
			if (head >= ready.length) {
				// Cycle: break it by stopping remaining nodes in insertion order.
				for (const id of affected) {
					if (!stopped.has(id)) ready.push(id)
				}
			}

			const id = ready[head++]!
			if (stopped.has(id)) continue
			stopped.add(id)
			try {
				await stop(id)
			} catch {
				// stop is best-effort by design; keep teardown progressing.
			}
			complete(id)
		}
		return
	}

	const inFlight = new Set<Promise<void>>()
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
