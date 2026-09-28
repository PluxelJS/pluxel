import { useQuery, useQueryClient } from '@tanstack/react-query'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../managementQuery'
import {
	buildPluginDependencyGraphProjection,
	type PluginDependencyGraphProjection,
} from './pluginDependencyGraphModel'

export type PluginDependencyGraphState = Readonly<{
	hasSnapshot: boolean
	graph: PluginDependencyGraphProjection | null
	isLoading: boolean
	isStale: boolean
	error?: string
	refetch: () => Promise<void>
}>

export function usePluginDependencyGraph(): PluginDependencyGraphState {
	const client = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const query = useQuery({
		queryKey: managementQueryKeys.pluginDependencyGraph(),
		queryFn: async () => buildPluginDependencyGraphProjection(await client.dependencies.graph()),
	})

	return {
		hasSnapshot: query.data !== undefined,
		graph: query.data ?? null,
		isLoading: query.isPending,
		isStale: query.isFetching && query.data !== undefined,
		...(query.error ? { error: runtimeErrorMessage(query.error, '无法读取插件依赖图') } : {}),
		refetch: async () => {
			await refetchManagementQuery(queryClient, managementQueryKeys.pluginDependencyGraph())
		},
	}
}
