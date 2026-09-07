import {
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { RuntimeStateDraft, RuntimeStateSnapshot } from './RuntimeStateStore'

export type RuntimeStateReadIndex = Readonly<{
	autoStartKeys: ReadonlySet<string>
	forkIdsByDefinition: ReadonlyMap<string, readonly string[]>
	forkNodeKeys: ReadonlySet<string>
}>

const readIndexes = new WeakMap<RuntimeStateSnapshot, RuntimeStateReadIndex>()

/** Builds immutable-state lookup indexes once per published snapshot identity. */
export function runtimeStateReadIndex(state: RuntimeStateSnapshot): RuntimeStateReadIndex {
	const cached = readIndexes.get(state)
	if (cached) return cached
	const index: RuntimeStateReadIndex = Object.freeze({
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

export function samePluginDefinitionAddress(
	left: PluginDefinitionAddress,
	right: PluginDefinitionAddress,
): boolean {
	return pluginDefinitionAddressEqual(left, right)
}

export function samePluginNodeAddress(left: PluginNodeAddress, right: PluginNodeAddress): boolean {
	return pluginNodeAddressEqual(left, right)
}

export function isPluginAutoStartEnabled(
	state: RuntimeStateSnapshot,
	node: PluginNodeAddress,
): boolean {
	return runtimeStateReadIndex(state).autoStartKeys.has(pluginNodeIndexKey(node))
}

export function setPluginAutoStart(
	draft: RuntimeStateDraft,
	node: PluginNodeAddress,
	autoStart: boolean,
): void {
	const index = draft.autoStart.findIndex((candidate) => samePluginNodeAddress(candidate, node))
	if (autoStart) {
		if (index < 0) draft.autoStart.push(node)
		return
	}
	if (index >= 0) draft.autoStart.splice(index, 1)
}

export function setPluginsAutoStart(
	draft: RuntimeStateDraft,
	nodes: Iterable<PluginNodeAddress>,
	autoStart: boolean,
): void {
	for (const node of nodes) setPluginAutoStart(draft, node, autoStart)
}

export function replaceAutoStartPlugins(
	draft: RuntimeStateDraft,
	nodes: Iterable<PluginNodeAddress>,
): void {
	draft.autoStart.length = 0
	for (const node of nodes) setPluginAutoStart(draft, node, true)
}

export function listForkIds(
	state: RuntimeStateSnapshot,
	definition: PluginDefinitionAddress,
): readonly string[] {
	return (
		runtimeStateReadIndex(state).forkIdsByDefinition.get(pluginDefinitionIndexKey(definition)) ?? []
	)
}
