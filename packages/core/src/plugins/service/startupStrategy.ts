import type { PluginIdentifier } from '../types'
import type { InitPlan } from './commitPlanner'

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

	const concurrency = normalizeConcurrency(opts.concurrency)
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

function normalizeConcurrency(value: number | undefined): number {
	if (value == null) return 8
	if (!Number.isFinite(value)) return 8
	const n = Math.floor(value)
	return n >= 1 ? n : 1
}
