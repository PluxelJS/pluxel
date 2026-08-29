import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { type RuntimeManagementClient, useRuntimeManagementClient } from '../../runtime'
import { PluginOverviewResource, type PluginOverview } from './pluginOverviewResource'

export { type PluginOverview, type PluginStatusEntry } from './pluginOverviewResource'

export type PluginOverviewSnapshot = Readonly<{
	hasSnapshot: boolean
	overview: PluginOverview | null
	isLoading: boolean
	isStale: boolean
	error?: string
	refetch: () => Promise<void>
}>

const resources = new WeakMap<RuntimeManagementClient, PluginOverviewResource>()

function resourceFor(client: RuntimeManagementClient): PluginOverviewResource {
	let resource = resources.get(client)
	if (!resource) {
		resource = new PluginOverviewResource(client)
		resources.set(client, resource)
	}
	return resource
}

export function invalidatePluginOverview(client: RuntimeManagementClient): void {
	resources.get(client)?.markStale()
}

export async function refreshPluginOverview(client: RuntimeManagementClient): Promise<void> {
	await resources.get(client)?.load(true)
}

export function usePluginOverview(): PluginOverviewSnapshot {
	const client = useRuntimeManagementClient()
	const resource = useMemo(() => resourceFor(client), [client])
	const snapshot = useSyncExternalStore(
		resource.subscribe,
		resource.getSnapshot,
		resource.getSnapshot,
	)
	useEffect(() => {
		void resource.load()
	}, [resource])
	const refetch = useCallback(async () => {
		resource.markStale()
		await resource.load(true)
	}, [resource])

	return {
		hasSnapshot: snapshot.overview !== null,
		overview: snapshot.overview,
		isLoading: snapshot.isLoading,
		isStale: snapshot.isStale,
		error: snapshot.error,
		refetch,
	}
}
