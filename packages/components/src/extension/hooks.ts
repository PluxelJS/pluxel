import { useEffect, useState } from 'react'
import { extensionRegistry } from './registry'

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
