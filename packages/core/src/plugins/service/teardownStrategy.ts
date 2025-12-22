import type { PluginIdentifier } from '../types'

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

	const concurrency = normalizeConcurrency(opts.concurrency, 1)

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

function normalizeConcurrency(value: number | undefined, fallback: number): number {
	if (value == null) return fallback
	if (!Number.isFinite(value)) return fallback
	const n = Math.floor(value)
	return n >= 1 ? n : 1
}
