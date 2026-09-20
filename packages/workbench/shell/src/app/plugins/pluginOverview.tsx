import { useQuery, useQueryClient } from '@tanstack/react-query'

import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../managementQuery'
import { buildPluginOverview, type PluginOverview } from './pluginOverviewModel'

export { type PluginOverview, type PluginStatusEntry } from './pluginOverviewModel'

export type PluginOverviewSnapshot = Readonly<{
	hasSnapshot: boolean
	overview: PluginOverview | null
	isLoading: boolean
	isStale: boolean
	error?: string
	refetch: () => Promise<void>
}>

export function usePluginOverview(): PluginOverviewSnapshot {
	const client = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const query = useQuery({
		queryKey: managementQueryKeys.pluginOverview(),
		queryFn: async () => buildPluginOverview(await client.catalog.snapshot()),
	})

	return {
		hasSnapshot: query.data !== undefined,
		overview: query.data ?? null,
		isLoading: query.isPending,
		isStale: query.isFetching && query.data !== undefined,
		...(query.error ? { error: runtimeErrorMessage(query.error, '无法读取插件概览') } : {}),
		refetch: async () => {
			await refetchManagementQuery(queryClient, managementQueryKeys.pluginOverview())
		},
	}
}
