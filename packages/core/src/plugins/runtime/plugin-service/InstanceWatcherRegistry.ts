import type { BasePlugin } from '../../composition/BasePlugin'
import type { PluginToken } from '../../types'
import type { PluginNodeAddress, PluginNodeSlot } from '../identity'
import type { PluginGraph } from '../PluginDefinitions'

type InstanceWatcher = {
	id: PluginNodeAddress | PluginNodeSlot | PluginToken
	resolvedKey: PluginNodeSlot | undefined
	lastInstance: BasePlugin | undefined
	lastPublishSeq: number
	callback: (instance: BasePlugin | undefined) => void
}

type InstanceWatcherCommitSummary = {
	graph: PluginGraph
	pluginChanges: {
		availabilityChanged: readonly PluginNodeSlot[]
	}
}

export class InstanceWatcherRegistry {
	private readonly watchersByResolvedKey = new Map<
		PluginNodeSlot | undefined,
		Set<InstanceWatcher>
	>()
	private publishSeq = 0

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: PluginNodeAddress | PluginNodeSlot | PluginToken,
		) => PluginNodeSlot | undefined,
		private readonly getRunningRuntimeInstance: (
			id: PluginNodeSlot | undefined,
		) => BasePlugin | undefined,
		private readonly logError: (error: unknown) => void,
	) {}

	public watch(
		graph: PluginGraph | undefined,
		id: PluginNodeAddress,
		cb: (instance: BasePlugin | undefined) => void,
	): () => void
	public watch<T extends PluginToken>(
		graph: PluginGraph | undefined,
		id: T,
		cb: (instance: InstanceType<T> | undefined) => void,
	): () => void
	public watch(
		graph: PluginGraph | undefined,
		id: PluginNodeSlot,
		cb: (instance: BasePlugin | undefined) => void,
	): () => void
	public watch(
		graph: PluginGraph | undefined,
		id: PluginNodeAddress | PluginNodeSlot | PluginToken,
		cb: (instance: BasePlugin | undefined) => void,
	): () => void {
		const resolved = this.resolveGraphKey(graph, id)
		const entry: InstanceWatcher = {
			id,
			resolvedKey: resolved,
			lastInstance: this.getRunningRuntimeInstance(resolved),
			lastPublishSeq: this.publishSeq,
			callback: cb as unknown as (instance: BasePlugin | undefined) => void,
		}
		this.add(entry)

		try {
			entry.callback(entry.lastInstance as BasePlugin | undefined)
		} catch (error) {
			this.logError(error)
		}

		let active = true
		return () => {
			if (!active) return
			active = false
			this.remove(entry)
		}
	}

	public publish(summary: InstanceWatcherCommitSummary): void {
		if (this.watchersByResolvedKey.size === 0) return
		const availabilityChanged = summary.pluginChanges.availabilityChanged
		if (availabilityChanged.length === 0) return
		const seq = ++this.publishSeq
		const availabilityChangedSet = new Set(availabilityChanged)

		for (let i = 0; i < availabilityChanged.length; i++) {
			const set = this.watchersByResolvedKey.get(availabilityChanged[i]!)
			if (!set || set.size === 0) continue
			this.flush(set, summary, seq)
		}

		const retargeted: InstanceWatcher[] = []
		for (const [resolvedKey, set] of this.watchersByResolvedKey) {
			if (availabilityChangedSet.has(resolvedKey)) continue
			for (const entry of set) {
				const nextResolved = this.resolveGraphKey(summary.graph, entry.id)
				if (nextResolved !== entry.resolvedKey) retargeted.push(entry)
			}
		}
		for (let i = 0; i < retargeted.length; i++) this.notify(retargeted[i]!, summary, seq)
	}

	private flush(
		set: Set<InstanceWatcher>,
		summary: InstanceWatcherCommitSummary,
		seq: number,
	): void {
		for (const entry of set) this.notify(entry, summary, seq)
	}

	private notify(entry: InstanceWatcher, summary: InstanceWatcherCommitSummary, seq: number): void {
		if (entry.lastPublishSeq === seq) return
		entry.lastPublishSeq = seq

		const nextResolved = this.resolveGraphKey(summary.graph, entry.id)
		if (nextResolved !== entry.resolvedKey) {
			this.remove(entry)
			entry.resolvedKey = nextResolved
			this.add(entry)
		}

		const instance = this.getRunningRuntimeInstance(entry.resolvedKey)
		if (instance === entry.lastInstance) return
		entry.lastInstance = instance
		try {
			entry.callback(instance)
		} catch (error) {
			this.logError(error)
		}
	}

	private add(entry: InstanceWatcher): void {
		let set = this.watchersByResolvedKey.get(entry.resolvedKey)
		if (!set) {
			set = new Set()
			this.watchersByResolvedKey.set(entry.resolvedKey, set)
		}
		set.add(entry)
	}

	private remove(entry: InstanceWatcher): void {
		const set = this.watchersByResolvedKey.get(entry.resolvedKey)
		set?.delete(entry)
		if (set && set.size === 0) this.watchersByResolvedKey.delete(entry.resolvedKey)
	}
}
