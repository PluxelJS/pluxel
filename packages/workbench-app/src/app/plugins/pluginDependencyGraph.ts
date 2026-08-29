import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { type RuntimeManagementClient, useRuntimeManagementClient } from '../../runtime'
import {
	PluginDependencyGraphResource,
	type PluginDependencyGraphProjection,
} from './pluginDependencyGraphResource'

export type PluginDependencyGraphState = Readonly<{
	hasSnapshot: boolean
	graph: PluginDependencyGraphProjection | null
	isLoading: boolean
	isStale: boolean
	error?: string
	refetch: () => Promise<void>
}>

const resources = new WeakMap<RuntimeManagementClient, PluginDependencyGraphResource>()

function resourceFor(client: RuntimeManagementClient): PluginDependencyGraphResource {
	let resource = resources.get(client)
	if (!resource) {
		resource = new PluginDependencyGraphResource(client)
		resources.set(client, resource)
	}
	return resource
}

export function invalidatePluginDependencyGraph(client: RuntimeManagementClient): void {
	resources.get(client)?.markStale()
}

export async function refreshPluginDependencyGraph(client: RuntimeManagementClient): Promise<void> {
	await resources.get(client)?.load(true)
}

export function usePluginDependencyGraph(): PluginDependencyGraphState {
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
		hasSnapshot: snapshot.graph !== null,
		graph: snapshot.graph,
		isLoading: snapshot.isLoading,
		isStale: snapshot.isStale,
		...(snapshot.error === undefined ? {} : { error: snapshot.error }),
		refetch,
	}
}
