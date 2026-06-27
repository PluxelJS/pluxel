import type { RuntimePluginHandle, RuntimePluginKey } from '../identity'
import type { PluginGraph } from '../PluginDefinitions'
import type { PluginLifecycleReport } from './LifecycleReport'
import type { RuntimeUpdateCommitMeta, RuntimeUpdateReason } from './RuntimeUpdateTransaction'

export type PluginReplacement = { readonly from: RuntimePluginKey; readonly to: RuntimePluginKey }

export type PluginCommitChanges = {
	readonly added: readonly RuntimePluginKey[]
	readonly replaced: readonly PluginReplacement[]
	readonly removed: readonly RuntimePluginKey[]
	readonly restarted: readonly RuntimePluginKey[]
	/**
	 * Plugins whose runtime availability may have changed in this commit.
	 *
	 * This includes anything that was stopped or (re)started (adds, replaces, restarts, retries).
	 * Useful for efficient optional-dependency watchers (e.g. FeatureHost.dep).
	 */
	readonly availabilityChanged: readonly RuntimePluginKey[]
}

export type RuntimeUpdateCommitSummary = {
	readonly reason?: RuntimeUpdateReason
	readonly affectedModules: readonly string[]
	readonly autoDisabled: readonly RuntimePluginKey[]
}

export interface CommitSummary {
	readonly graph: PluginGraph
	readonly pluginChanges: PluginCommitChanges
	readonly runtimeUpdate: RuntimeUpdateCommitSummary
	readonly lifecycleReport: PluginLifecycleReport
}

export type CommitExecutionDelta = {
	readonly added: readonly RuntimePluginKey[]
	readonly replaced: readonly PluginReplacement[]
	readonly removed: readonly RuntimePluginKey[]
}

export type CommitExecutionPlan = {
	readonly added: Set<RuntimePluginKey>
	readonly replaced: PluginReplacement[]
	readonly removed: Set<RuntimePluginKey>
	readonly restartRequested: Set<RuntimePluginKey>
	readonly toStop: Set<RuntimePluginKey>
	readonly toStart: Set<RuntimePluginKey>
	readonly toStopSlots: Set<number>
	readonly toStartSlots: Set<number>
}

export type RuntimePluginKeyResolver = (
	graph: PluginGraph | undefined,
	id: RuntimePluginHandle,
) => RuntimePluginKey | undefined

export const EMPTY_DELTA = {
	added: [],
	removed: [],
	replaced: [],
	affected: [],
	retargetedTokens: [],
} as const

export const EMPTY_PLUGIN_COMMIT_CHANGES: PluginCommitChanges = Object.freeze({
	added: Object.freeze([]) as readonly RuntimePluginKey[],
	replaced: Object.freeze([]) as readonly PluginReplacement[],
	removed: Object.freeze([]) as readonly RuntimePluginKey[],
	restarted: Object.freeze([]) as readonly RuntimePluginKey[],
	availabilityChanged: Object.freeze([]) as readonly RuntimePluginKey[],
})

export function hasCommitWork(
	hasPendingChanges: boolean,
	pendingStartSize: number,
	pendingRestartSize: number,
): boolean {
	return hasPendingChanges || pendingStartSize > 0 || pendingRestartSize > 0
}

export function createCommitExecutionPlan(args: {
	oldGraph: PluginGraph
	graph: PluginGraph
	delta: CommitExecutionDelta
	restartRequested: Set<RuntimePluginKey>
	pendingStart: Iterable<RuntimePluginKey>
	resolveGraphKey: RuntimePluginKeyResolver
}): CommitExecutionPlan {
	const { oldGraph, graph, delta, restartRequested, pendingStart, resolveGraphKey } = args
	const added = new Set(delta.added)
	const replaced = [...delta.replaced]
	const removed = new Set(delta.removed)
	const toStop = new Set<RuntimePluginKey>(removed)
	const toStart = new Set<RuntimePluginKey>()

	for (let i = 0; i < replaced.length; i++) {
		const { from, to } = replaced[i]!
		toStop.add(from)
		if (graph.has(to)) toStart.add(to)
	}
	for (const id of added) {
		if (graph.has(id)) toStart.add(id)
	}
	for (const id of restartRequested) {
		const stopKey = resolveGraphKey(oldGraph, id)
		if (stopKey && oldGraph.has(stopKey)) toStop.add(stopKey)
		const startKey = resolveGraphKey(graph, id)
		if (startKey && graph.has(startKey)) toStart.add(startKey)
	}

	// Retry previously failed plugins opportunistically on any later commit.
	for (const id of pendingStart) {
		if (toStop.has(id)) continue
		const key = resolveGraphKey(graph, id)
		if (key && graph.has(key)) toStart.add(key)
	}

	return {
		added,
		replaced,
		removed,
		restartRequested,
		toStop,
		toStart,
		toStopSlots: collectExistingSlots(oldGraph, toStop),
		toStartSlots: collectExistingSlots(graph, toStart),
	}
}

export function isCommitExecutionPlanEmpty(
	delta: CommitExecutionDelta,
	plan: CommitExecutionPlan,
): boolean {
	return (
		delta.added.length === 0 &&
		delta.removed.length === 0 &&
		delta.replaced.length === 0 &&
		plan.toStopSlots.size === 0 &&
		plan.toStartSlots.size === 0
	)
}

export function collectRuntimeEvictions(plan: CommitExecutionPlan): Set<RuntimePluginKey> {
	const evict = new Set<RuntimePluginKey>(plan.toStop)
	for (let i = 0; i < plan.replaced.length; i++) {
		evict.add(plan.replaced[i]!.from)
	}
	for (const id of plan.toStart) {
		if (!plan.toStop.has(id)) evict.add(id)
	}
	return evict
}

export function createPluginCommitChanges(
	plan: CommitExecutionPlan,
	failed: ReadonlySet<RuntimePluginKey>,
): PluginCommitChanges {
	return {
		added: [...plan.added],
		replaced: [...plan.replaced],
		removed: [...plan.removed],
		restarted: collectRestartedSummary(plan, failed),
		availabilityChanged: uniqueRuntimePluginKeys(plan.toStop, plan.toStart),
	}
}

export function createRuntimeUpdateSummary(
	meta: RuntimeUpdateCommitMeta | null,
): RuntimeUpdateCommitSummary {
	const affectedModules = meta ? uniqueStrings(meta.affectedModules) : []
	const autoDisabled = meta ? uniqueRuntimePluginKeys(meta.autoDisabled) : []
	return meta
		? { reason: meta.reason, affectedModules, autoDisabled }
		: { affectedModules, autoDisabled }
}

function collectExistingSlots(graph: PluginGraph, ids: Iterable<RuntimePluginKey>): Set<number> {
	const slots = new Set<number>()
	for (const id of ids) {
		const slot = graph.slotOf(id)
		if (slot !== undefined) slots.add(slot)
	}
	return slots
}

function collectRestartedSummary(
	plan: CommitExecutionPlan,
	failed: ReadonlySet<RuntimePluginKey>,
): RuntimePluginKey[] {
	const structural = new Set<RuntimePluginKey>()
	for (const id of plan.added) structural.add(id)
	for (const id of plan.removed) structural.add(id)
	for (const id of failed) structural.add(id)
	for (const { from, to } of plan.replaced) {
		structural.add(from)
		structural.add(to)
	}

	const restarted: RuntimePluginKey[] = []
	const seen = new Set<RuntimePluginKey>()
	for (const id of plan.toStart) {
		if (structural.has(id) || seen.has(id)) continue
		seen.add(id)
		restarted.push(id)
	}
	return restarted
}

function uniqueRuntimePluginKeys(
	first: Iterable<RuntimePluginKey>,
	second?: Iterable<RuntimePluginKey>,
): RuntimePluginKey[] {
	const out = new Set<RuntimePluginKey>()
	for (const id of first) out.add(id)
	if (second) {
		for (const id of second) out.add(id)
	}
	return [...out]
}

function uniqueStrings(values: Iterable<string>): string[] {
	return [...new Set(values)]
}
