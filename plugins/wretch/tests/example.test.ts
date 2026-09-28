import { Result } from '@pluxel/core/better-result'
import { standardServices } from '@pluxel/services'
import { createTestHost } from '@pluxel/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { CustomerHttpConsumer } from './fixtures/customer-http-consumer.ts'
import {
	CustomerNotFound,
	WretchExamplePlugin,
	WretchExampleWorkbench,
} from './fixtures/wretch-example.ts'
import { openWretchSettings } from './workbench-helpers.ts'

afterEach(() => vi.unstubAllGlobals())

describe('WretchExamplePlugin', () => {
	it('demonstrates native client composition, required DI, business HTTP, and headless operation', async () => {
		vi.stubGlobal('fetch', async (input: string, options: RequestInit) =>
			Response.json({
				url: input,
				headers: Object.fromEntries(new Headers(options.headers)),
			}),
		)

		{
			await using host = await createTestHost({
				services: standardServices({ persistence: { mode: 'memory' } }),
			})
			await host.start(WretchPlugin, { catalog: [WretchExamplePlugin] })
			await host.start(WretchExamplePlugin, {
				initialConfig: {
					baseUrl: 'https://example.test/api',
					inspectPath: '/inspect-me',
					retryAttempts: 0,
				},
			})

			await expect(host.require(WretchExamplePlugin).inspect()).resolves.toMatchObject({
				url: 'https://example.test/api/inspect-me',
				headers: {
					accept: 'application/json',
					'x-pluxel-client': 'WretchExamplePlugin',
				},
			})

			const response = await host.http.fetch(new URL('/wretch-example/inspect', host.http.origin))
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({
				url: 'https://example.test/api/inspect-me',
			})
		}
	})

	it('returns a local Result for a missing customer and projects it at the HTTP boundary', async () => {
		vi.stubGlobal('fetch', async (input: string) => {
			if (input.endsWith('/customers/alice')) {
				return Response.json({ id: 'alice', name: 'Alice' })
			}
			if (input.endsWith('/customers/missing')) {
				return Response.json({ message: 'not found' }, { status: 404 })
			}
			if (input.endsWith('/customers/malformed')) return Response.json({ id: 42 })
			if (input.endsWith('/customers/offline')) throw new TypeError('network unavailable')
			return Response.json({ message: 'unavailable' }, { status: 503 })
		})

		await using host = await createTestHost({
			services: standardServices({ persistence: { mode: 'memory' } }),
		})
		await host.start(WretchPlugin, { catalog: [WretchExamplePlugin] })
		const customerPlugin = await host.start(WretchExamplePlugin, {
			initialConfig: { baseUrl: 'https://example.test/api', retryAttempts: 0 },
		})
		await host.start(CustomerHttpConsumer)

		const found = await customerPlugin.findCustomer('alice')
		expect(Result.isError(found)).toBe(false)
		if (Result.isError(found)) throw found.error
		expect(found.value).toEqual({ id: 'alice', name: 'Alice' })

		const missing = await customerPlugin.findCustomer('missing')
		expect(Result.isError(missing)).toBe(true)
		if (!Result.isError(missing)) throw new Error('Expected a missing customer')
		expect(missing.error).toBeInstanceOf(CustomerNotFound)
		expect(missing.error._tag).toBe('CustomerNotFound')
		expect(missing.error.id).toBe('missing')

		const foundHttp = await host.http.fetch(
			new URL('/wretch-example/customers/alice', host.http.origin),
		)
		expect(foundHttp.status).toBe(200)
		expect(await foundHttp.json()).toEqual({
			ok: true,
			customer: { id: 'alice', name: 'Alice' },
		})

		const missingHttp = await host.http.fetch(
			new URL('/wretch-example/customers/missing', host.http.origin),
		)
		expect(missingHttp.status).toBe(404)
		expect(await missingHttp.json()).toEqual({
			ok: false,
			code: 'customer_not_found',
			message: 'Customer missing was not found',
		})

		await expect(customerPlugin.findCustomer('unavailable')).rejects.toMatchObject({ status: 503 })
		await expect(customerPlugin.findCustomer('malformed')).rejects.toMatchObject({
			name: 'ValiError',
		})
		await expect(customerPlugin.findCustomer('offline')).rejects.toThrow('network unavailable')
	})

	it('places and opens the provider-owned settings Attachment', async () => {
		{
			await using host = await createTestHost({
				workbench: true,
				services: standardServices({ persistence: { mode: 'memory' } }),
			})
			await host.start(WretchPlugin, { catalog: [WretchExamplePlugin] })
			await host.start(WretchExamplePlugin)

			expect(host.isRunning(WretchPlugin)).toBe(true)
			expect(host.isRunning(WretchExamplePlugin)).toBe(true)

			using settings = await openWretchSettings(
				host,
				WretchExamplePlugin,
				WretchExampleWorkbench.http,
			)
			expect(settings).toMatchObject({
				kind: 'attachment',
				params: {},
				federatedViewRef: { expose: './views/settings' },
			})
			expect(await settings.api.snapshotDto()).toMatchObject({
				settings: { headers: {} },
				hostTimeoutMs: 30_000,
				effectiveTimeoutMs: 30_000,
			})
		}
	})
})
