import { QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { createManagementQueryClient, managementQueryKeys } from '../src/app/managementQuery'
import { refreshPluginReadModels } from '../src/app/plugins/pluginReadModels'

describe('management query lifecycle', () => {
	it('deduplicates a query and reuses it while fresh', async () => {
		const queryClient = createManagementQueryClient()
		const read = vi.fn().mockResolvedValue({ revision: 1 })
		const options = { queryKey: managementQueryKeys.pluginOverview(), queryFn: read }

		const first = queryClient.fetchQuery(options)
		const duplicate = queryClient.fetchQuery(options)
		expect(await first).toEqual({ revision: 1 })
		expect(await duplicate).toEqual({ revision: 1 })
		expect(read).toHaveBeenCalledOnce()
		expect(await queryClient.fetchQuery(options)).toEqual({ revision: 1 })
		expect(read).toHaveBeenCalledOnce()
	})

	it('keeps last-known-good data when a background refresh fails', async () => {
		const queryClient = createManagementQueryClient()
		const key = managementQueryKeys.pluginOverview()
		const read = vi
			.fn()
			.mockResolvedValueOnce({ revision: 1 })
			.mockRejectedValueOnce(new Error('offline'))
		await queryClient.fetchQuery({ queryKey: key, queryFn: read })
		await queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' })

		await expect(queryClient.fetchQuery({ queryKey: key, queryFn: read })).rejects.toThrow(
			'offline',
		)
		expect(queryClient.getQueryData(key)).toEqual({ revision: 1 })
		expect(queryClient.getQueryState(key)?.error).toEqual(new Error('offline'))
	})

	it('fences an old RPC result and performs a second read after mutation invalidation', async () => {
		const queryClient = createManagementQueryClient()
		let releaseOld!: (value: { revision: number }) => void
		const oldResult = new Promise<{ revision: number }>((resolve) => {
			releaseOld = resolve
		})
		const readOverview = vi
			.fn<() => Promise<{ revision: number }>>()
			.mockReturnValueOnce(oldResult)
			.mockResolvedValueOnce({ revision: 2 })
		const observer = new QueryObserver(queryClient, {
			queryKey: managementQueryKeys.pluginOverview(),
			queryFn: readOverview,
		})
		const unsubscribe = observer.subscribe(() => undefined)
		await Promise.resolve()

		const refreshed = refreshPluginReadModels(queryClient)
		await vi.waitFor(() => expect(readOverview).toHaveBeenCalledTimes(2))
		releaseOld({ revision: 1 })
		await refreshed

		expect(queryClient.getQueryData(managementQueryKeys.pluginOverview())).toEqual({ revision: 2 })
		unsubscribe()
	})

	it('clears all cached DTOs at session teardown', async () => {
		const queryClient = createManagementQueryClient()
		queryClient.setQueryData(managementQueryKeys.runtimeMeta(), { application: 'fixture' })
		queryClient.clear()
		expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
	})
})
