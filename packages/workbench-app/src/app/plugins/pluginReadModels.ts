import type { QueryClient } from '@tanstack/react-query'
import { managementQueryKeys, refetchManagementQuery } from '../managementQuery'

export async function refreshPluginReadModels(queryClient: QueryClient): Promise<void> {
	await Promise.all([
		refetchManagementQuery(queryClient, managementQueryKeys.pluginOverview()),
		refetchManagementQuery(queryClient, managementQueryKeys.pluginDependencyGraph()),
	])
}
