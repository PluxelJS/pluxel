import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { extensionRegistry } from './registry'
import {
	getExtensionRouteVersion,
	isPluginUILoaded,
	subscribeExtensionModuleChanges,
	subscribeExtensionRouteChanges,
} from './runtime'

export { useExtensionManager } from './manager/useExtensionManager'
export type { PluginInfo, ExtensionManagerOptions } from './manager/types'

/**
 * 获取扩展 Registry 版本（用于触发重渲染）
 */
export function useExtensionVersion(): number {
	const [version, setVersion] = useState(() => extensionRegistry.getVersion())

	useEffect(() => {
		return extensionRegistry.subscribe(() => {
			setVersion(extensionRegistry.getVersion())
		})
	}, [])

	return version
}

/**
 * 获取扩展路由版本（用于响应路由注册变化）
 */
export function useExtensionRouteVersion(): number {
	return useSyncExternalStore(
		subscribeExtensionRouteChanges,
		getExtensionRouteVersion,
		getExtensionRouteVersion,
	)
}

/**
 * 监听指定插件 UI 模块的加载状态
 */
export function usePluginUILoadState(pluginName?: string): boolean {
	const getSnapshot = useCallback(() => {
		if (!pluginName) return false
		return isPluginUILoaded(pluginName)
	}, [pluginName])

	return useSyncExternalStore(subscribeExtensionModuleChanges, getSnapshot, getSnapshot)
}
