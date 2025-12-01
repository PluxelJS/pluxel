import { useEffect, useState, useSyncExternalStore } from 'react'
import { extensionRegistry } from './registry'
import { getExtensionRuntimeRevision, subscribeExtensionRuntimeChanges } from './runtime'

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
 * 统一的扩展运行时版本号
 */
export function useExtensionRuntimeVersion(): number {
	return useSyncExternalStore(
		subscribeExtensionRuntimeChanges,
		getExtensionRuntimeRevision,
		getExtensionRuntimeRevision,
	)
}
