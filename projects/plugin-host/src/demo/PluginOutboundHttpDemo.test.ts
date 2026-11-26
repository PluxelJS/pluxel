import { Result } from '@pluxel/core/better-result'
import { elysia } from '@pluxel/services/elysia'
import { createTestHost } from '@pluxel/test'
import { describe, expect, it, vi } from 'vitest'
import {
	CustomerHttpConsumer,
	CustomerNotFound,
	OutboundCustomerPlugin,
} from './PluginOutboundHttpDemo'

describe('built-in outbound HTTP', () => {
	it('composes and retries requests through the native Wretch client in a headless Host', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockImplementation(async (input, options) => {
				const request = new Request(input, options)
				return Response.json({
					url: request.url,
					headers: Object.fromEntries(request.headers),
				})
			})
		await using host = await createTestHost({
			coreConfig: { http: { fetch, allowedOrigins: ['https://example.test'] } },
		})
		const customers = await host.start(OutboundCustomerPlugin.nodeAddress(), {
			initialConfig: { baseUrl: 'https://example.test/api', retryAttempts: 1 },
		})

		await expect(customers.inspect()).resolves.toMatchObject({
			url: 'https://example.test/api/inspect-me',
			headers: {
				accept: 'application/json',
				'x-pluxel-client': 'OutboundCustomerPlugin',
			},
		})
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it('returns a local Result for a missing customer and projects it at the HTTP boundary', async () => {
		await using host = await createTestHost({
			services: [elysia()],
			coreConfig: {
				http: {
					async fetch(input, options) {
						const path = new URL(new Request(input, options).url).pathname
						switch (path) {
							case '/api/customers/alice':
								return Response.json({ id: 'alice', name: 'Alice' })
							case '/api/customers/missing':
								return Response.json({ message: 'not found' }, { status: 404 })
							case '/api/customers/malformed':
								return Response.json({ id: 42 })
							case '/api/customers/offline':
								throw new TypeError('network unavailable')
							default:
								return Response.json({ message: 'unavailable' }, { status: 503 })
						}
					},
				},
			},
		})
		const customers = await host.start(OutboundCustomerPlugin.nodeAddress(), {
			initialConfig: { baseUrl: 'https://example.test/api' },
		})
		await host.start(CustomerHttpConsumer.nodeAddress())

		const found = await customers.findCustomer('alice')
		if (Result.isError(found)) throw found.error
		expect(found.value).toEqual({ id: 'alice', name: 'Alice' })

		const missing = await customers.findCustomer('missing')
		if (!Result.isError(missing)) throw new Error('Expected a missing customer')
		expect(missing.error).toBeInstanceOf(CustomerNotFound)
		expect(missing.error.id).toBe('missing')

		const foundHttp = await host.http.fetch(
			new URL('/wretch-example/customers/alice', host.http.origin),
		)
		expect(foundHttp.status).toBe(200)
		await expect(foundHttp.json()).resolves.toEqual({
			ok: true,
			customer: { id: 'alice', name: 'Alice' },
		})

		const missingHttp = await host.http.fetch(
			new URL('/wretch-example/customers/missing', host.http.origin),
		)
		expect(missingHttp.status).toBe(404)
		await expect(missingHttp.json()).resolves.toEqual({
			ok: false,
			code: 'customer_not_found',
			message: 'Customer missing was not found',
		})

		await expect(customers.findCustomer('unavailable')).rejects.toMatchObject({ status: 503 })
		await expect(customers.findCustomer('malformed')).rejects.toMatchObject({ name: 'ValiError' })
		await expect(customers.findCustomer('offline')).rejects.toThrow('network unavailable')
	})
})
