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
		const sequence = input.batch.sequence ?? this.nextSequence
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
		if (definitions.size === 0) return
		this.nextSequence = Math.max(this.nextSequence, sequence + 1)
		for (const key of definitions) {
			this.definitions.delete(key)
			this.definitions.set(key, fallback)
		}
		for (const [key, value] of nodes) {
			this.nodes.delete(key)
			this.nodes.set(key, value)
		}
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
