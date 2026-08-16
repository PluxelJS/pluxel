import { pluginNodeAddressOf, withRuntimeHost } from '@pluxel/runtime/test'
import type { WorkbenchLayout } from '@pluxel/runtime/workbench'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE,
} from '@pluxel/runtime/web/paths'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { WretchExamplePlugin } from './fixtures/wretch-example.ts'

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
				host.cfg(WretchPlugin).enable()
				host.cfg(WretchExamplePlugin).set({
					baseUrl: 'https://example.test/api',
					inspectPath: '/inspect-me',
					retryAttempts: 0,
				})
				host.cfg(WretchExamplePlugin).enable()
				await host.commit()

				await expect(host.require(WretchExamplePlugin).inspect()).resolves.toMatchObject({
					url: 'https://example.test/api/inspect-me',
					headers: {
						accept: 'application/json',
						'x-pluxel-client': 'WretchExamplePlugin',
					},
				})

				const response = await host.ctx.http.fetch(
					new Request('http://local.test/wretch-example/inspect'),
				)
				expect(response.status).toBe(200)
				expect(await response.json()).toMatchObject({
					url: 'https://example.test/api/inspect-me',
				})
			},
			{ workbench: false },
		)
	})

	it('mounts the shared HTTP settings renderer in a Workbench-enabled runtime', async () => {
		await withRuntimeHost(async (host) => {
			host.add([WretchPlugin, WretchExamplePlugin])
			host.cfg(WretchPlugin).enable()
			host.cfg(WretchExamplePlugin).enable()
			await host.commit()

			expect(host.isRunning(WretchPlugin)).toBe(true)
			expect(host.isRunning(WretchExamplePlugin)).toBe(true)

			const response = await host.ctx.http.fetch(
				new Request(
					`http://local.test${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE}/${encodeURIComponent(JSON.stringify(pluginNodeAddressOf(WretchExamplePlugin)))}`,
				),
			)
			const layout = (await response.json()) as WorkbenchLayout
			expect(layout.items[0]).toMatchObject({
				owner: {
					address: pluginNodeAddressOf(WretchPlugin),
					displayName: 'WretchPlugin',
					rootExportName: 'WretchPlugin',
				},
				target: {
					address: pluginNodeAddressOf(WretchExamplePlugin),
					displayName: 'WretchExamplePlugin',
					rootExportName: 'WretchExamplePlugin',
				},
				viewId: 'HttpSettings',
				port: { id: '@pluxel/wretch.settings' },
			})
		})
	})
})
