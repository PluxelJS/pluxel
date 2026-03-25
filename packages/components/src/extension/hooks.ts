import { useCallback, useSyncExternalStore } from 'react'
import {
	getPluginUiModuleRevision,
	getPluginUiRegistryRevision,
	subscribePluginUiModuleChanges,
	subscribePluginUiRegistryChanges,
} from './internal/pluginUiRegistry'
import {
	getExtensionModuleState,
	getExtensionModuleStates,
	subscribeExtensionModuleStates,
	subscribePluginExtensionModuleState,
} from './internal/module-state'

/**
 * 插件 UI 模块注册表版本号。
 */
export function usePluginUiVersion(pluginName?: string): number {
	const subscribe = useCallback(
		(listener: () => void) => {
			if (pluginName) return subscribePluginUiModuleChanges(pluginName, listener)
			return subscribePluginUiRegistryChanges(listener)
		},
		[pluginName],
	)

	const getSnapshot = useCallback(() => {
		if (pluginName) return getPluginUiModuleRevision(pluginName)
		return getPluginUiRegistryRevision()
	}, [pluginName])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useExtensionModuleState(pluginName: string) {
	const subscribe = useCallback(
		(listener: () => void) => subscribePluginExtensionModuleState(pluginName, listener),
		[pluginName],
	)
	const getSnapshot = useCallback(() => getExtensionModuleState(pluginName), [pluginName])
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useExtensionModuleStates() {
	return useSyncExternalStore(
		subscribeExtensionModuleStates,
		getExtensionModuleStates,
		getExtensionModuleStates,
	)
}
