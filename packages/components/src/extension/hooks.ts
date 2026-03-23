import { useCallback, useSyncExternalStore } from 'react'
import {
	getExtensionRuntimeRevision,
	getPluginExtensionRuntimeRevision,
	subscribeExtensionRuntimeChanges,
	subscribePluginExtensionRuntimeChanges,
} from './internal/runtime'
import {
	getExtensionModuleState,
	getExtensionModuleStates,
	subscribeExtensionModuleStates,
	subscribePluginExtensionModuleState,
} from './internal/module-state'

/**
 * 统一的扩展运行时版本号
 */
export function useExtensionRuntimeVersion(pluginName?: string): number {
	const subscribe = useCallback(
		(listener: () => void) => {
			if (pluginName) return subscribePluginExtensionRuntimeChanges(pluginName, listener)
			return subscribeExtensionRuntimeChanges(listener)
		},
		[pluginName],
	)

	const getSnapshot = useCallback(() => {
		if (pluginName) return getPluginExtensionRuntimeRevision(pluginName)
		return getExtensionRuntimeRevision()
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
