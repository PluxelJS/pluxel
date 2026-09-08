import {
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	type CommitSummary,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import {
	clonePluginRecentUpdateSnapshot,
	clonePluginUpdateBatchSnapshot,
	cloneRuntimeUpdateSnapshot,
	cloneRuntimeUpdateError,
	type RuntimeUpdateSnapshot,
	type RuntimeUpdateError,
	type PluginRecentUpdateSnapshot,
	type PluginUpdateBatchSnapshot,
	type PluginUpdateLifecycleIssue,
} from '../plugin-execution'
import type { PluginRecentUpdateRead } from '../runtime/capabilities'

const MAX_DEFINITIONS = 512
const MAX_NODES = 2_048

/** Route-owned history, shared across replacement hosts; node facts never fall back to sibling forks. */
export class PluginRecentUpdateTracker implements PluginRecentUpdateRead {
	private readonly definitions = new Map<string, PluginRecentUpdateSnapshot>()
	private readonly nodes = new Map<string, PluginRecentUpdateSnapshot>()
	private nextSequence = 1
	private latest: RuntimeUpdateSnapshot | null = null
	private activeSequence: number | undefined
	private settlement: RuntimeUpdateSnapshot | null = null
	private readonly observers = new Set<(snapshot: RuntimeUpdateSnapshot | null) => void>()

	latestUpdate(): RuntimeUpdateSnapshot | null {
		return this.latest
	}

	subscribeUpdates(observer: (snapshot: RuntimeUpdateSnapshot | null) => void): () => void {
		this.observers.add(observer)
		return () => {
			this.observers.delete(observer)
		}
	}

	beginUpdate(trigger: string | null): number {
		if (this.activeSequence !== undefined) throw new Error('A route update is already active')
		const sequence = this.nextSequence++
		this.activeSequence = sequence
		this.settlement = null
		this.publish({
			sequence,
			state: 'updating',
			phase: 'evaluate',
			outcome: null,
			durationMs: 0,
			trigger,
			error: null,
		})
		return sequence
	}

	hasUpdateSettlement(): boolean {
		return this.settlement !== null
	}

	updatePhase(phase: NonNullable<RuntimeUpdateSnapshot['phase']>): void {
		if (this.latest?.state === 'updating' && this.activeSequence !== undefined)
			this.publish({ ...this.latest, phase })
	}

	/** Settle once after all route rollback/commit handling has completed. */
	finishUpdate(error: RuntimeUpdateError | null = null): void {
		if (!this.latest || this.activeSequence === undefined) return
		const sequence = this.activeSequence
		if (!this.settlement) throw new Error('Route update has no recorded settlement')
		if (error) error = cloneRuntimeUpdateError(error)
		const lateFailure =
			error && this.settlement.outcome === 'applied'
				? { outcome: 'applied-with-issues' as const, phase: 'commit' as const }
				: {}
		const settled = cloneRuntimeUpdateSnapshot({ ...this.settlement, ...lateFailure, error })!
		if (error) {
			const batches = new Map<PluginUpdateBatchSnapshot, PluginUpdateBatchSnapshot>()
			for (const map of [this.definitions, this.nodes]) {
				for (const [key, value] of map) {
					if (value.batch.sequence === sequence) {
						let batch = batches.get(value.batch)
						if (!batch) {
							batch = clonePluginUpdateBatchSnapshot({ ...value.batch, ...lateFailure, error })
							batches.set(value.batch, batch)
						}
						map.set(key, Object.freeze({ ...value, batch }))
					}
				}
			}
		}
		this.activeSequence = undefined
		this.publish(settled)
		this.settlement = null
	}

	private publish(snapshot: RuntimeUpdateSnapshot): void {
		this.latest = cloneRuntimeUpdateSnapshot(snapshot)
		for (const observer of this.observers) {
			try {
				observer(this.latest)
			} catch {
				/* Observers cannot alter route settlement. */
			}
		}
	}

	resolveRecentUpdate(address: PluginNodeAddress): PluginRecentUpdateSnapshot | null {
		const definition = this.definitions.get(pluginDefinitionIndexKey(address.definition))
		if (!definition) return null
		const node = this.nodes.get(formatPluginNodeReference(address))
		return node?.batch === definition.batch ? node : definition
	}

	record(
		input: Readonly<{
			definitionKeys: Iterable<string>
			batch: Omit<PluginUpdateBatchSnapshot, 'sequence'> & { sequence?: number }
			lifecycle?: Readonly<{
				commit: CommitSummary
				addressOf: (slot: PluginNodeSlot) => PluginNodeAddress
			}>
		}>,
	): void {
		const sequence = input.batch.sequence ?? this.activeSequence ?? this.nextSequence
		const batch = clonePluginUpdateBatchSnapshot({ ...input.batch, sequence })
		const definitions = new Set(input.definitionKeys)
		const nodeIssues = new Map<string, PluginUpdateLifecycleIssue[]>()
		if (input.lifecycle) {
			const { commit, addressOf } = input.lifecycle
			const observe = (slot: PluginNodeSlot): PluginUpdateLifecycleIssue[] => {
				const address = addressOf(slot)
				definitions.add(pluginDefinitionIndexKey(address.definition))
				const key = formatPluginNodeReference(address)
				let issues = nodeIssues.get(key)
				if (!issues) {
					issues = []
					nodeIssues.set(key, issues)
				}
				return issues
			}
			const changes = commit.pluginChanges
			for (const slot of [
				...changes.added,
				...changes.removed,
				...changes.restarted,
				...changes.availabilityChanged,
			])
				observe(slot)
			for (const replacement of changes.replaced) {
				observe(replacement.from)
				observe(replacement.to)
			}
			for (const issue of commit.lifecycleReport.issues) {
				observe(issue.plugin).push({
					phase: issue.phase,
					kind: issue.kind,
					message: issue.error?.message ?? issue.message,
					blockedBy: issue.blockedBy ? formatPluginNodeReference(addressOf(issue.blockedBy)) : null,
				})
			}
		}
		// Prepare and validate everything before publishing any history.
		const fallback = clonePluginRecentUpdateSnapshot({ batch, lifecycle: null })
		const nodes = [...nodeIssues].map(
			([key, issues]) =>
				[
					key,
					Object.freeze({
						batch: fallback.batch,
						lifecycle: clonePluginRecentUpdateSnapshot({ batch, lifecycle: { issues } }).lifecycle,
					}),
				] as const,
		)
		this.nextSequence = Math.max(this.nextSequence, sequence + 1)
		for (const key of definitions) {
			this.definitions.delete(key)
			this.definitions.set(key, fallback)
		}
		for (const [key, value] of nodes) {
			this.nodes.delete(key)
			this.nodes.set(key, value)
		}
		const latest = cloneRuntimeUpdateSnapshot({
			sequence,
			phase: batch.phase,
			outcome: batch.outcome,
			durationMs: batch.durationMs,
			state: 'settled',
			trigger: this.activeSequence === sequence ? (this.latest?.trigger ?? null) : null,
			error: batch.error ?? null,
		})!
		// Active routes attach the original error before delivering their one settlement.
		if (this.activeSequence === sequence) this.settlement = latest
		else this.publish(latest)
		trim(this.definitions, MAX_DEFINITIONS)
		trim(this.nodes, MAX_NODES)
	}
}

function trim<T>(map: Map<string, T>, maximum: number): void {
	while (map.size > maximum) {
		const first = map.keys().next().value
		if (first === undefined) break
		map.delete(first)
	}
}
