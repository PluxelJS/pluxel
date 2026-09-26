import { QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import {
	createManagementQueryClient,
	managementQueryKeys,
	refreshDependencyQueries,
} from '../src/app/managementQuery'
import type { PluginNodeAddress } from '@pluxel/core'

const owner = (exportName: string): PluginNodeAddress => ({
	definition: { entry: { kind: 'package-root', packageName: '@fixture/cache' }, exportName },
	variant: 'default',
})

describe('dependency editor refresh', () => {
	it('refreshes all active editors and leaves inactive editors stale without fetching unrelated queries', async () => {
		const client = createManagementQueryClient()
		const activeKeys = [
			managementQueryKeys.providerPolicy(owner('Memory')),
			managementQueryKeys.providerPolicy(owner('Redis')),
			managementQueryKeys.consumerRequirements(owner('Consumer')),
		]
		const reads = activeKeys.map(() => vi.fn(async () => 'new'))
		const unsubscribes = activeKeys.map((queryKey, index) => {
			client.setQueryData(queryKey, 'old')
			return new QueryObserver(client, { queryKey, queryFn: reads[index] }).subscribe(() => {})
		})
		const inactiveKey = managementQueryKeys.consumerRequirements(owner('ClosedConsumer'))
		client.setQueryData(inactiveKey, 'old')
		client.setQueryData(managementQueryKeys.runtimeMeta(), 'unchanged')
		try {
			await refreshDependencyQueries(client)
			for (const [index, queryKey] of activeKeys.entries()) {
				expect(client.getQueryData(queryKey)).toBe('new')
				expect(reads[index]).toHaveBeenCalledTimes(1)
			}
			expect(client.getQueryData(inactiveKey)).toBe('old')
			expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(true)
			expect(client.getQueryState(managementQueryKeys.runtimeMeta())?.isInvalidated).toBe(false)
		} finally {
			for (const unsubscribe of unsubscribes) unsubscribe()
			client.clear()
		}
	})
})
