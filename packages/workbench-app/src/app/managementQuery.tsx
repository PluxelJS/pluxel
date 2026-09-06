import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'

export const MANAGEMENT_QUERY_STALE_TIME = 30_000

export const managementQueryKeys = {
	all: ['management'] as const,
	runtimeMeta: () => [...managementQueryKeys.all, 'runtime-meta'] as const,
	pluginOverview: () => [...managementQueryKeys.all, 'plugins', 'overview'] as const,
	pluginDependencyGraph: () => [...managementQueryKeys.all, 'plugins', 'dependency-graph'] as const,
	pluginConfigs: () => [...managementQueryKeys.all, 'plugins', 'config'] as const,
	pluginConfigPresentations: () =>
		[...managementQueryKeys.pluginConfigs(), 'presentation'] as const,
	pluginConfigPresentation: (owner: PluginNodeAddress) =>
		[...managementQueryKeys.pluginConfigPresentations(), pluginNodeIndexKey(owner)] as const,
	pluginSavedConfigs: () => [...managementQueryKeys.pluginConfigs(), 'saved'] as const,
	pluginSavedConfig: (owner: PluginNodeAddress) =>
		[...managementQueryKeys.pluginSavedConfigs(), pluginNodeIndexKey(owner)] as const,
	securityOverview: () => [...managementQueryKeys.all, 'security', 'overview'] as const,
	securityEvents: () => [...managementQueryKeys.all, 'security', 'events'] as const,
	loggingPolicy: () => [...managementQueryKeys.all, 'logging', 'policy'] as const,
	dependencies: () => [...managementQueryKeys.all, 'dependencies'] as const,
	providerPolicy: (owner: PluginNodeAddress) =>
		[...managementQueryKeys.dependencies(), 'provider-policy', pluginNodeIndexKey(owner)] as const,
	consumerRequirements: (owner: PluginNodeAddress) =>
		[
			...managementQueryKeys.dependencies(),
			'consumer-requirements',
			pluginNodeIndexKey(owner),
		] as const,
} as const

const mountedQueryClients = new Set<QueryClient>()

if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => {
		for (const client of mountedQueryClients) {
			void client.invalidateQueries({ queryKey: managementQueryKeys.pluginConfigPresentations() })
		}
	})
}

export function createManagementQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: 5 * 60_000,
				networkMode: 'always',
				refetchOnReconnect: false,
				refetchOnWindowFocus: true,
				retry: false,
				staleTime: MANAGEMENT_QUERY_STALE_TIME,
			},
			mutations: { networkMode: 'always', retry: false },
		},
	})
}

export async function refetchManagementQuery(
	client: QueryClient,
	queryKey: QueryKey,
): Promise<void> {
	// Cap'n Web calls are not AbortSignal-aware. Cancellation fences the cache commit;
	// RuntimeManagementClient still detaches and disposes any late transport result.
	await client.cancelQueries({ queryKey, exact: true })
	await client.invalidateQueries({ queryKey, exact: true, refetchType: 'all' })
}

export function ManagementQueryProvider({ children }: { children: ReactNode }) {
	const [client] = useState(createManagementQueryClient)
	useEffect(() => {
		mountedQueryClients.add(client)
		return () => {
			mountedQueryClients.delete(client)
			client.clear()
		}
	}, [client])
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

// Refresh active dependency editors together; inactive entries remain stale until opened.
export async function refreshDependencyQueries(client: QueryClient): Promise<void> {
	const queryKey = managementQueryKeys.dependencies()
	await client.cancelQueries({ queryKey })
	await client.invalidateQueries({ queryKey })
}
