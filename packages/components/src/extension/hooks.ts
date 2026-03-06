import { useCallback, useSyncExternalStore } from 'react'
import { extensionRegistry } from './internal/registry'
import {
	getExtensionRuntimeRevision,
	getPluginExtensionRuntimeRevision,
	subscribeExtensionRuntimeChanges,
	subscribePluginExtensionRuntimeChanges,
} from './internal/runtime'

/**
 * 获取扩展 Registry 版本（用于触发重渲染）
 */
export function useExtensionVersion(): number {
	return useSyncExternalStore(
		extensionRegistry.subscribe,
		() => extensionRegistry.getVersion(),
		() => extensionRegistry.getVersion(),
	)
}

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
