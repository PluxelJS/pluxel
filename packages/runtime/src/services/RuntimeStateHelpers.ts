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
	enabledKeys: ReadonlySet<string>
	forkIdsByDefinition: ReadonlyMap<string, readonly string[]>
	forkNodeKeys: ReadonlySet<string>
}>

const readIndexes = new WeakMap<RuntimeStateSnapshot, RuntimeStateReadIndex>()

/** Builds immutable-state lookup indexes once per published snapshot identity. */
export function runtimeStateReadIndex(state: RuntimeStateSnapshot): RuntimeStateReadIndex {
	const cached = readIndexes.get(state)
	if (cached) return cached
	const index: RuntimeStateReadIndex = Object.freeze({
		enabledKeys: new Set(state.enabled.map(pluginNodeIndexKey)),
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

export function isPluginEnabled(state: RuntimeStateSnapshot, node: PluginNodeAddress): boolean {
	return runtimeStateReadIndex(state).enabledKeys.has(pluginNodeIndexKey(node))
}

export function setPluginEnabled(
	draft: RuntimeStateDraft,
	node: PluginNodeAddress,
	enabled: boolean,
): void {
	const index = draft.enabled.findIndex((candidate) => samePluginNodeAddress(candidate, node))
	if (enabled) {
		if (index < 0) draft.enabled.push(node)
		return
	}
	if (index >= 0) draft.enabled.splice(index, 1)
}

export function setPluginsEnabled(
	draft: RuntimeStateDraft,
	nodes: Iterable<PluginNodeAddress>,
	enabled: boolean,
): void {
	for (const node of nodes) setPluginEnabled(draft, node, enabled)
}

export function replaceEnabledPlugins(
	draft: RuntimeStateDraft,
	nodes: Iterable<PluginNodeAddress>,
): void {
	draft.enabled.length = 0
	for (const node of nodes) setPluginEnabled(draft, node, true)
}

export function listForkIds(
	state: RuntimeStateSnapshot,
	definition: PluginDefinitionAddress,
): readonly string[] {
	return (
		runtimeStateReadIndex(state).forkIdsByDefinition.get(pluginDefinitionIndexKey(definition)) ?? []
	)
}
