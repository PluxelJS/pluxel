import type { PluginDefinitionAddressSnapshot, PluginNodeAddressSnapshot } from '@pluxel/core'
import type { RuntimeStateDraft, RuntimeStateSnapshot } from './RuntimeStateStore'

export function samePluginDefinitionAddress(
	left: PluginDefinitionAddressSnapshot,
	right: PluginDefinitionAddressSnapshot,
): boolean {
	if (left.exportName !== right.exportName || left.entry.kind !== right.entry.kind) return false
	return left.entry.kind === 'package-root'
		? right.entry.kind === 'package-root' && left.entry.packageName === right.entry.packageName
		: right.entry.kind === 'source-entry' && left.entry.source === right.entry.source
}

export function samePluginNodeAddress(
	left: PluginNodeAddressSnapshot,
	right: PluginNodeAddressSnapshot,
): boolean {
	if (!samePluginDefinitionAddress(left.definition, right.definition)) return false
	if (left.instance !== right.instance) return false
	return left.instance === 'default'
		? true
		: right.instance === 'fork' && left.forkId === right.forkId
}

export function isPluginEnabled(
	state: RuntimeStateSnapshot,
	node: PluginNodeAddressSnapshot,
): boolean {
	return state.enabled.some((candidate) => samePluginNodeAddress(candidate, node))
}

export function setPluginEnabled(
	draft: RuntimeStateDraft,
	node: PluginNodeAddressSnapshot,
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
	nodes: Iterable<PluginNodeAddressSnapshot>,
	enabled: boolean,
): void {
	for (const node of nodes) setPluginEnabled(draft, node, enabled)
}

export function replaceEnabledPlugins(
	draft: RuntimeStateDraft,
	nodes: Iterable<PluginNodeAddressSnapshot>,
): void {
	draft.enabled.length = 0
	for (const node of nodes) setPluginEnabled(draft, node, true)
}

export function listForkIds(
	state: RuntimeStateSnapshot,
	definition: PluginDefinitionAddressSnapshot,
): readonly string[] {
	return (
		state.forks.find((entry) => samePluginDefinitionAddress(entry.definition, definition))
			?.forkIds ?? []
	)
}
