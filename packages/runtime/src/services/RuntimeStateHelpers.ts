import {
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { RuntimeStateDraft, RuntimeStateSnapshot } from './RuntimeStateStore'

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
	return state.enabled.some((candidate) => samePluginNodeAddress(candidate, node))
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
		state.forks.find((entry) => samePluginDefinitionAddress(entry.definition, definition))
			?.forkIds ?? []
	)
}
