import type { PluginNodeAddress } from '@pluxel/core'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFetch } from '../../src/web/admin-access'
import { expectData } from '../../src/web/eden'
import { createRuntimeTransportClient } from '../../src/web/transport-client'

describe('runtime transport client', () => {
	it('carries structured Workbench targets in the query instead of a path segment', async () => {
		const target: PluginNodeAddress = {
			definition: {
				entry: { kind: 'package-root', packageName: '@acme/orders' },
				exportName: 'OrdersPlugin',
			},
			variant: 'default',
		}
		const fetch = vi.fn<RuntimeFetch>(
			async () =>
				new Response(JSON.stringify({ revision: 1, target: null, items: [] }), {
					headers: { 'content-type': 'application/json' },
				}),
		)
		const client = createRuntimeTransportClient({
			origin: 'https://runtime.test',
			fetch,
			adminAccess: false,
		})

		try {
			await client.workbench.pluginLayout(target)
			const input = fetch.mock.calls[0]?.[0]
			const url = new URL(input instanceof Request ? input.url : String(input))
			expect(url.pathname).toBe('/__pluxel/runtime/workbench/layout/plugin')
			expect(JSON.parse(url.searchParams.get('target')!)).toEqual(target)
		} finally {
			client.dispose()
		}
	})

	it('reports an HTTP status before attempting to stringify an Eden error body', async () => {
		await expect(
			expectData(
				Promise.resolve({
					data: null,
					error: new Error('[object AsyncGenerator]'),
					response: new Response(null, { status: 404 }),
				}),
			),
		).rejects.toThrow('HTTP 404')
	})
})
