import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeManagementClient } from '../../src/web/client'
import type { RuntimeFetch } from '../../src/web/admin-access'

describe('Management RPC fetch boundary', () => {
	it("uses the caller-provided fetch for Cap'n Web HTTP batches", async () => {
		const host = createRuntimeHost({ workbench: false, management: {} })
		try {
			const runtimeFetch = vi.fn<RuntimeFetch>(async (input, init) => {
				const request =
					input instanceof Request ? new Request(input, init) : new Request(input, init)
				return await host.fetch(request)
			})
			const client = createRuntimeManagementClient({
				origin: 'http://runtime.test',
				fetch: runtimeFetch,
				adminAccess: false,
			})

			await expect(client.plugins.list()).resolves.toMatchObject({
				plugins: [],
				summary: { total: 0 },
			})
			expect(runtimeFetch).toHaveBeenCalled()
			const rpcCall = runtimeFetch.mock.calls.find(([, init]) => init?.method === 'POST')
			expect(rpcCall).toBeDefined()
			expect(String(rpcCall?.[0])).toContain('/__pluxel/runtime/rpc')
		} finally {
			await host.dispose()
		}
	})
})
