import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { ExtensionLifecycleManager } from './ExtensionLifecycleManager'
import type { ExtensionManagerOptions, PluginInfo } from './types'

export function useExtensionManager(
	plugins: PluginInfo[],
	options: ExtensionManagerOptions,
) {
	const { fetchManifest, pollInterval } = options
	const manager = useMemo(
		() => new ExtensionLifecycleManager({ fetchManifest }),
		[fetchManifest],
	)

	useEffect(() => {
		manager.start()
		return () => manager.dispose()
	}, [manager])

	useEffect(() => {
		manager.setPollInterval(pollInterval)
	}, [manager, pollInterval])

	useEffect(() => {
		manager.setPlugins(plugins)
	}, [manager, plugins])

	const snapshot = useSyncExternalStore(
		manager.subscribe,
		manager.getSnapshot,
		manager.getSnapshot,
	)

	const refresh = useCallback(() => manager.refresh(), [manager])

	return { ...snapshot, refresh }
}
