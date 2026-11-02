import {
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { HostStateDraft, HostStateSnapshot } from './policy'

export type HostStateReadIndex = Readonly<{
	autoStartKeys: ReadonlySet<string>
	forkIdsByDefinition: ReadonlyMap<string, readonly string[]>
	forkNodeKeys: ReadonlySet<string>
}>

const readIndexes = new WeakMap<HostStateSnapshot, HostStateReadIndex>()

/** Builds immutable-state lookup indexes once per published snapshot identity. */
export function hostStateReadIndex(state: HostStateSnapshot): HostStateReadIndex {
	const cached = readIndexes.get(state)
	if (cached) return cached
	const forkIdsByDefinition = new Map<string, string[]>()
	for (const node of state.forks) {
		if (node.variant !== 'fork') continue
		const key = pluginDefinitionIndexKey(node.definition)
		const ids = forkIdsByDefinition.get(key) ?? []
		ids.push(node.forkId)
		forkIdsByDefinition.set(key, ids)
	}
	const index: HostStateReadIndex = Object.freeze({
		autoStartKeys: new Set(state.autoStart.map(pluginNodeIndexKey)),
		forkIdsByDefinition,
		forkNodeKeys: new Set(state.forks.map(pluginNodeIndexKey)),
	})
	readIndexes.set(state, index)
	return index
}

export function isPluginAutoStartEnabled(
	state: HostStateSnapshot,
	node: PluginNodeAddress,
): boolean {
	return hostStateReadIndex(state).autoStartKeys.has(pluginNodeIndexKey(node))
}

export function setPluginAutoStart(
	draft: HostStateDraft,
	node: PluginNodeAddress,
	autoStart: boolean,
): void {
	const index = draft.autoStart.findIndex((candidate) => pluginNodeAddressEqual(candidate, node))
	if (autoStart) {
		if (index < 0) draft.autoStart.push(node)
		return
	}
	if (index >= 0) draft.autoStart.splice(index, 1)
}

export function setPluginsAutoStart(
	draft: HostStateDraft,
	nodes: Iterable<PluginNodeAddress>,
	autoStart: boolean,
): void {
	for (const node of nodes) setPluginAutoStart(draft, node, autoStart)
}

export function replaceAutoStartPlugins(
	draft: HostStateDraft,
	nodes: Iterable<PluginNodeAddress>,
): void {
	draft.autoStart.length = 0
	for (const node of nodes) setPluginAutoStart(draft, node, true)
}

export function listForkIds(
	state: HostStateSnapshot,
	definition: PluginDefinitionAddress,
): readonly string[] {
	return (
		hostStateReadIndex(state).forkIdsByDefinition.get(pluginDefinitionIndexKey(definition)) ?? []
	)
}
