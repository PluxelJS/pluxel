import { pluginNodeAddressOf, withRuntimeHost } from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { WretchExamplePlugin } from './fixtures/wretch-example.ts'
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

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, WretchExamplePlugin])
				host.start(WretchPlugin)
				host.cfg(WretchExamplePlugin).set({
					baseUrl: 'https://example.test/api',
					inspectPath: '/inspect-me',
					retryAttempts: 0,
				})
				host.start(WretchExamplePlugin)
				await host.commit()

				await expect(host.require(WretchExamplePlugin).inspect()).resolves.toMatchObject({
					url: 'https://example.test/api/inspect-me',
					headers: {
						accept: 'application/json',
						'x-pluxel-client': 'WretchExamplePlugin',
					},
				})

				const response = await host.fetch(new Request('http://local.test/wretch-example/inspect'))
				expect(response.status).toBe(200)
				expect(await response.json()).toMatchObject({
					url: 'https://example.test/api/inspect-me',
				})
			},
			{ workbench: false },
		)
	})

	it('places and opens the provider-owned settings Attachment', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, WretchExamplePlugin])
				host.start(WretchPlugin)
				host.start(WretchExamplePlugin)
				await host.commit()

				expect(host.isRunning(WretchPlugin)).toBe(true)
				expect(host.isRunning(WretchExamplePlugin)).toBe(true)

				const consumer = pluginNodeAddressOf(WretchExamplePlugin)
				const provider = pluginNodeAddressOf(WretchPlugin)
				const layout = requireWorkbench(host.ctx).registry.getLayout(consumer)
				expect(layout.entries[0]).toMatchObject({
					descriptor: {
						kind: 'attachment-placement',
						consumer: consumer.definition,
						key: 'http',
						provider: {
							kind: 'attachment',
							owner: provider.definition,
							key: 'settings',
						},
					},
					target: {
						node: consumer,
						displayName: 'WretchExamplePlugin',
					},
					renderer: provider,
					placement: { kind: 'tab', label: 'HTTP', icon: 'settings' },
					federatedViewRef: {
						expose: './views/settings',
						descriptor: {
							kind: 'attachment',
							owner: provider.definition,
							key: 'settings',
						},
					},
				})
				using settings = await openWretchSettings(host, WretchExamplePlugin)
				expect(settings.api.snapshot()).toMatchObject({
					settings: { headers: {} },
					hostTimeoutMs: 30_000,
					effectiveTimeoutMs: 30_000,
				})
			},
			{ workbench: { enabled: true } },
		)
	})
})
