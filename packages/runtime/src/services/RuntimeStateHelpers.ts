import type { RuntimeStateDraft, RuntimeStateSnapshot } from './RuntimeStateStore'

export function isPluginEnabled(state: RuntimeStateSnapshot, pluginId: string): boolean {
	return state.enabled.includes(pluginId)
}

export function setPluginEnabled(
	draft: RuntimeStateDraft,
	pluginId: string,
	enabled: boolean,
): void {
	if (enabled) draft.enabled.add(pluginId)
	else draft.enabled.delete(pluginId)
}

export function setPluginsEnabled(
	draft: RuntimeStateDraft,
	pluginIds: Iterable<string>,
	enabled: boolean,
): void {
	for (const pluginId of pluginIds) setPluginEnabled(draft, pluginId, enabled)
}

export function replaceEnabledPlugins(
	draft: RuntimeStateDraft,
	pluginIds: Iterable<string>,
): void {
	draft.enabled.clear()
	for (const pluginId of pluginIds) {
		if (typeof pluginId === 'string' && pluginId) draft.enabled.add(pluginId)
	}
}

export function listForkIds(
	state: RuntimeStateSnapshot,
	basePluginId: string,
): readonly string[] {
	return state.forks[basePluginId] ?? []
}
