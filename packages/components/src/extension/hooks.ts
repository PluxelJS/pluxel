import { useSyncExternalStore } from 'react'
import { extensionRegistry } from './registry'
import {
	getExtensionRuntimeRevision,
	getPluginExtensionRuntimeRevision,
	subscribeExtensionRuntimeChanges,
	subscribePluginExtensionRuntimeChanges,
} from './runtime'

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
	if (!pluginName) {
		return useSyncExternalStore(
			subscribeExtensionRuntimeChanges,
			getExtensionRuntimeRevision,
			getExtensionRuntimeRevision,
		)
	}
	return useSyncExternalStore(
		(listener) => subscribePluginExtensionRuntimeChanges(pluginName, listener),
		() => getPluginExtensionRuntimeRevision(pluginName),
		() => getPluginExtensionRuntimeRevision(pluginName),
	)
}
