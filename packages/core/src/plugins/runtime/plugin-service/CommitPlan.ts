import type { PluginNodeSlot } from '../identity'
import type { PluginIdentifier } from '../../types'
import type { PluginGraph } from '../PluginDefinitions'
import type { PluginLifecycleReport } from './LifecycleReport'
import type { RuntimeUpdateCommitMeta, RuntimeUpdateReason } from './RuntimeUpdateTransaction'

export type PluginReplacement = { readonly from: PluginNodeSlot; readonly to: PluginNodeSlot }

export type PluginCommitChanges = {
	readonly added: readonly PluginNodeSlot[]
	readonly replaced: readonly PluginReplacement[]
	readonly removed: readonly PluginNodeSlot[]
	readonly restarted: readonly PluginNodeSlot[]
	/**
	 * Plugins whose runtime availability may have changed in this commit.
	 *
	 * This includes anything that was stopped or (re)started (adds, replaces, restarts, retries).
	 * Useful for efficient optional-dependency watchers (e.g. PluginHost.use).
	 */
	readonly availabilityChanged: readonly PluginNodeSlot[]
}

export type RuntimeUpdateCommitSummary = {
	readonly reason?: RuntimeUpdateReason
	readonly affectedModules: readonly string[]
	readonly autoDisabled: readonly PluginNodeSlot[]
}

export interface CommitSummary {
	readonly graph: PluginGraph
	readonly pluginChanges: PluginCommitChanges
	readonly runtimeUpdate: RuntimeUpdateCommitSummary
	readonly lifecycleReport: PluginLifecycleReport
}

export type CommitExecutionDelta = {
	readonly added: readonly PluginNodeSlot[]
	readonly replaced: readonly PluginReplacement[]
	readonly removed: readonly PluginNodeSlot[]
}

export type CommitExecutionPlan = {
	readonly added: Set<PluginNodeSlot>
	readonly replaced: PluginReplacement[]
	readonly removed: Set<PluginNodeSlot>
	readonly restartRequested: Set<PluginNodeSlot>
	readonly toStop: Set<PluginNodeSlot>
	readonly toStart: Set<PluginNodeSlot>
	readonly toStopSlots: Set<number>
	readonly toStartSlots: Set<number>
}

export type PluginNodeResolver = (
	graph: PluginGraph | undefined,
	id: PluginIdentifier | PluginNodeSlot,
) => PluginNodeSlot | undefined

export const EMPTY_DELTA = {
	added: [],
	removed: [],
	replaced: [],
	affected: [],
	retargetedTokens: [],
} as const

export const EMPTY_PLUGIN_COMMIT_CHANGES: PluginCommitChanges = Object.freeze({
	added: Object.freeze([]) as readonly PluginNodeSlot[],
	replaced: Object.freeze([]) as readonly PluginReplacement[],
	removed: Object.freeze([]) as readonly PluginNodeSlot[],
	restarted: Object.freeze([]) as readonly PluginNodeSlot[],
	availabilityChanged: Object.freeze([]) as readonly PluginNodeSlot[],
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
	restartRequested: Set<PluginNodeSlot>
	pendingStart: Iterable<PluginNodeSlot>
	resolveGraphKey: PluginNodeResolver
}): CommitExecutionPlan {
	const { oldGraph, graph, delta, restartRequested, pendingStart, resolveGraphKey } = args
	const added = new Set(delta.added)
	const replaced = [...delta.replaced]
	const removed = new Set(delta.removed)
	const toStop = new Set<PluginNodeSlot>(removed)
	const toStart = new Set<PluginNodeSlot>()

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

export function collectRuntimeEvictions(plan: CommitExecutionPlan): Set<PluginNodeSlot> {
	const evict = new Set<PluginNodeSlot>(plan.toStop)
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
	failed: ReadonlySet<PluginNodeSlot>,
): PluginCommitChanges {
	return {
		added: [...plan.added],
		replaced: [...plan.replaced],
		removed: [...plan.removed],
		restarted: collectRestartedSummary(plan, failed),
		availabilityChanged: uniquePluginNodeSlots(plan.toStop, plan.toStart),
	}
}

export function createRuntimeUpdateSummary(
	meta: RuntimeUpdateCommitMeta | null,
): RuntimeUpdateCommitSummary {
	const affectedModules = meta ? uniqueStrings(meta.affectedModules) : []
	const autoDisabled = meta ? uniquePluginNodeSlots(meta.autoDisabled) : []
	return meta
		? { reason: meta.reason, affectedModules, autoDisabled }
		: { affectedModules, autoDisabled }
}

function collectExistingSlots(graph: PluginGraph, ids: Iterable<PluginNodeSlot>): Set<number> {
	const slots = new Set<number>()
	for (const id of ids) {
		const slot = graph.slotOf(id)
		if (slot !== undefined) slots.add(slot)
	}
	return slots
}

function collectRestartedSummary(
	plan: CommitExecutionPlan,
	failed: ReadonlySet<PluginNodeSlot>,
): PluginNodeSlot[] {
	const structural = new Set<PluginNodeSlot>()
	for (const id of plan.added) structural.add(id)
	for (const id of plan.removed) structural.add(id)
	for (const id of failed) structural.add(id)
	for (const { from, to } of plan.replaced) {
		structural.add(from)
		structural.add(to)
	}

	const restarted: PluginNodeSlot[] = []
	const seen = new Set<PluginNodeSlot>()
	for (const id of plan.toStart) {
		if (structural.has(id) || seen.has(id)) continue
		seen.add(id)
		restarted.push(id)
	}
	return restarted
}

function uniquePluginNodeSlots(
	first: Iterable<PluginNodeSlot>,
	second?: Iterable<PluginNodeSlot>,
): PluginNodeSlot[] {
	const out = new Set<PluginNodeSlot>()
	for (const id of first) out.add(id)
	if (second) {
		for (const id of second) out.add(id)
	}
	return [...out]
}

function uniqueStrings(values: Iterable<string>): string[] {
	return [...new Set(values)]
}
