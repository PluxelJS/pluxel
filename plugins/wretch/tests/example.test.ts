import { standardServices } from '@pluxel/services'
import { createTestHost } from '@pluxel/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { WretchExamplePlugin, WretchExampleWorkbench } from './fixtures/wretch-example.ts'
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
