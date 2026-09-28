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
	const index: HostStateReadIndex = Object.freeze({
		autoStartKeys: new Set(state.autoStart.map(pluginNodeIndexKey)),
		forkIdsByDefinition: new Map(
			state.forks.map((entry) => [pluginDefinitionIndexKey(entry.definition), entry.forkIds]),
		),
		forkNodeKeys: new Set(
			state.forks.flatMap((entry) =>
				entry.forkIds.map((forkId) =>
					pluginNodeIndexKey({ definition: entry.definition, variant: 'fork', forkId }),
				),
			),
		),
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
