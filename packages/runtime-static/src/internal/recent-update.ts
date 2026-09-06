import {
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	clonePluginRecentUpdateSnapshot,
	type PluginRecentUpdateRead,
	type PluginRecentUpdateSnapshot,
} from '@pluxel/runtime/internal'

const MAX_RECENT_PLUGIN_UPDATES = 512

type StaticRuntimeRecentUpdateResult =
	| Readonly<{ outcome: 'applied'; phase: null; durationMs: number }>
	| Readonly<{
			outcome: 'applied-with-issues'
			phase: 'lifecycle' | 'commit'
			durationMs: number
	  }>
	| Readonly<{
			outcome: 'retained-previous'
			phase: 'evaluate' | 'inject' | 'commit'
			durationMs: number
	  }>
	| Readonly<{
			outcome: 'restored-previous'
			phase: 'application-reload'
			durationMs: number
	  }>

/** Route-owned, bounded diagnostics shared by replacement hosts in one Vite process. */
export class StaticRuntimeRecentUpdateTracker implements PluginRecentUpdateRead {
	private readonly updates = new Map<string, PluginRecentUpdateSnapshot>()
	private nextSequence = 1

	resolveRecentUpdate(address: PluginNodeAddress): PluginRecentUpdateSnapshot | null {
		return this.updates.get(pluginDefinitionIndexKey(address.definition)) ?? null
	}

	record(
		definitions: Iterable<PluginDefinitionAddress>,
		result: StaticRuntimeRecentUpdateResult,
	): void {
		const keys = new Set<string>()
		for (const definition of definitions) keys.add(pluginDefinitionIndexKey(definition))
		if (keys.size === 0) return

		const update = clonePluginRecentUpdateSnapshot({
			...result,
			sequence: this.nextSequence++,
		})
		for (const key of keys) {
			this.updates.delete(key)
			this.updates.set(key, update)
		}
		while (this.updates.size > MAX_RECENT_PLUGIN_UPDATES) {
			const oldest = this.updates.keys().next().value as string | undefined
			if (oldest === undefined) break
			this.updates.delete(oldest)
		}
	}
}
