import { BasePlugin, createRuntimeHost, Plugin, pluginNodeAddressOf } from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { describe, expect, it } from 'vitest'
import { RuntimeRpcApi } from '../src/api/http/rpc/RuntimeRpcApi'
import { RUNTIME_INTERNAL_API_BASE } from '../src/web/paths'

const request = (path: string) =>
	new Request(`http://runtime.test${RUNTIME_INTERNAL_API_BASE}${path}`)

const HttpSmokeWorkbench = workbench.extension({
	contract: workbenchContract.define({
		views: {
			Overview: {
				placements: [workbenchContract.tab({ label: 'HTTP smoke' })],
			},
		},
	}),
})

@Plugin()
class WorkbenchHttpSmokePlugin extends BasePlugin {
	override init(): void {
		this.ctx.workbench?.mount(HttpSmokeWorkbench, {})
	}
}

describe('runtime management and Workbench planes', () => {
	it('runs headless management without installing Workbench', async () => {
		const host = createRuntimeHost({ workbench: false, management: {} })
		try {
			expect(host.ctx.workbench).toBeUndefined()
			expect(host.ctx.root.adminAccess).toBeDefined()
			expect(host.ctx.root.runtimeManagement).toBeDefined()
			expect(host.ctx.root.pluginCatalogLayout).toBeDefined()

			const metaResponse = await host.fetch(request('/meta'))
			expect(metaResponse.status).toBe(200)
			const meta = await metaResponse.json()
			expect(meta).toMatchObject({
				protocol: { name: 'pluxel.management', major: 1 },
				workbench: { enabled: false },
				transport: { rpc: '/rpc' },
			})
			expect(
				(meta as { protocol: { capabilities: string[] } }).protocol.capabilities,
			).not.toContain('vault')

			const security = await host.fetch(request('/security'))
			expect(security.status).toBe(200)
			await expect(security.json()).resolves.toMatchObject({ vault: { enabled: false } })
			const workbenchCatalog = await host.fetch(request('/workbench/catalog'))
			expect(workbenchCatalog.status).toBe(404)
			const vaultUnlock = await host.fetch(
				new Request(`http://runtime.test${RUNTIME_INTERNAL_API_BASE}/security/vault/unlock`, {
					method: 'POST',
				}),
			)
			expect(vaultUnlock.status).toBe(404)

			const rpc = new RuntimeRpcApi(host.ctx)
			await expect(rpc.pluginsList()).resolves.toMatchObject({
				plugins: [],
				summary: { total: 0 },
			})
			await expect(rpc.pluginGroups()).resolves.toEqual([])
		} finally {
			await host.dispose()
		}
	})

	it('installs no management or Workbench routes when both planes are disabled', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			expect(host.ctx.workbench).toBeUndefined()
			expect(host.ctx.root.adminAccess).toBeUndefined()
			expect(host.ctx.root.runtimeManagement).toBeUndefined()
			expect(host.ctx.root.pluginCatalogLayout).toBeUndefined()
			const meta = await host.fetch(request('/meta'))
			const unknown = await host.fetch(request('/unknown'))
			expect(meta.status).toBe(404)
			expect(unknown.status).toBe(404)
		} finally {
			await host.dispose()
		}
	})

	it('derives private management access and serves Workbench transport routes', async () => {
		const host = createRuntimeHost({ workbench: { enabled: true } })
		try {
			host.add(WorkbenchHttpSmokePlugin)
			host.cfg(WorkbenchHttpSmokePlugin).enable()
			await host.commit()

			expect(host.ctx.workbench).toBeDefined()
			await expect(host.ctx.root.adminAccess?.describe()).resolves.toMatchObject({
				exposure: 'private',
				allow: true,
			})
			await expect(
				host.fetch(request('/meta')).then((response) => response.json()),
			).resolves.toMatchObject({
				workbench: { enabled: true },
				transport: { rpc: '/rpc' },
			})

			const target = pluginNodeAddressOf(WorkbenchHttpSmokePlugin)
			const pluginLayoutUrl = new URL(request('/workbench/layout/plugin').url)
			pluginLayoutUrl.searchParams.set('target', JSON.stringify(target))
			const [catalog, globalLayout, pluginLayout] = await Promise.all([
				host.fetch(request('/workbench/catalog')),
				host.fetch(request('/workbench/layout/global')),
				host.fetch(new Request(pluginLayoutUrl)),
			])

			for (const response of [catalog, globalLayout, pluginLayout]) {
				expect(response.status).toBe(200)
				expect(response.headers.get('content-type')).toContain('application/json')
				expect(response.headers.get('cache-control')).toBe('no-store')
			}
			await expect(catalog.json()).resolves.toMatchObject({ bundles: [], states: [] })
			await expect(globalLayout.json()).resolves.toMatchObject({ target: null, items: [] })
			await expect(pluginLayout.json()).resolves.toMatchObject({
				target: {
					address: target,
					displayName: 'WorkbenchHttpSmokePlugin',
					rootExportName: 'WorkbenchHttpSmokePlugin',
				},
				items: [
					expect.objectContaining({
						viewId: 'Overview',
						owner: expect.objectContaining({ address: target }),
						placement: 'plugin.tabs',
					}),
				],
			})
		} finally {
			await host.dispose()
		}
	})

	it('rejects unsupported management configuration fields', () => {
		expect(() =>
			createRuntimeHost({
				workbench: { enabled: true, unknownField: true },
			} as never),
		).toThrow(/workbench includes unsupported "unknownField"/)
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: { unknownField: true },
			} as never),
		).toThrow(/management includes unsupported "unknownField"/)
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: { access: { unknownField: true } },
			} as never),
		).toThrow(/management\.access includes unsupported "unknownField"/)
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: { pluginGroups: false },
			} as never),
		).toThrow(/management\.pluginGroups must be an array/)
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: {
					pluginGroups: [{ id: 'core', name: 'Core', unknownField: true }],
				},
			} as never),
		).toThrow(/management\.pluginGroups\[0\] includes unsupported "unknownField"/)
	})

	it('advertises Vault only when the optional capability is installed', async () => {
		const host = createRuntimeHost({
			workbench: false,
			management: {},
			vault: {},
		})
		try {
			const meta = (await host.fetch(request('/meta')).then((response) => response.json())) as {
				protocol: { capabilities: string[] }
			}
			expect(meta.protocol.capabilities).toContain('vault')
		} finally {
			await host.dispose()
		}
	})
})
