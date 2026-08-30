import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'

import { RuntimeManagementTargetImpl } from '../src/services/management/RuntimeManagementTarget'
import { RUNTIME_SESSION_PATH } from '../src/web/session/protocol'

describe('runtime Management plane installation', () => {
	it('installs headless Management as a capability with no dynamic HTTP API', async () => {
		const host = createRuntimeHost({ workbench: false, management: {} })
		try {
			expect(host.ctx.workbench).toBeUndefined()
			expect(host.ctx.root.adminAccess).toBeDefined()
			expect(host.ctx.root.runtimeManagement).toBeDefined()
			expect(host.ctx.root.pluginCatalogLayout).toBeDefined()

			const target = new RuntimeManagementTargetImpl(host.ctx)
			expect(target.describe()).toMatchObject({
				protocol: { name: 'pluxel.management', major: 1 },
				workbench: { enabled: false },
			})
			expect(target.describe().protocol.capabilities).not.toContain('vault')
			await expect(target.pluginsList()).resolves.toMatchObject({
				plugins: [],
				summary: { total: 0 },
			})
			await expect(target.securityOverview()).resolves.toMatchObject({
				vault: { enabled: false },
			})

			const oldDynamicPath = await host.fetch(
				new Request('http://runtime.test/__pluxel/runtime/meta'),
			)
			expect(oldDynamicPath.status).toBe(404)
		} finally {
			await host.dispose()
		}
	})

	it('allocates no Management endpoint or backend when Management and Workbench are disabled', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			expect(host.ctx.root.adminAccess).toBeUndefined()
			expect(host.ctx.root.runtimeManagement).toBeUndefined()
			expect(host.ctx.root.pluginCatalogLayout).toBeUndefined()
			const response = await host.fetch(
				new Request(`http://runtime.test${RUNTIME_SESSION_PATH}`, {
					headers: { connection: 'upgrade', upgrade: 'websocket' },
				}),
			)
			expect(response.status).toBe(404)
		} finally {
			await host.dispose()
		}
	})

	it('rejects unsupported management configuration fields', () => {
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: { unknownField: true },
			} as never),
		).toThrow(/management includes unsupported "unknownField"/)
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: { pluginGroups: false },
			} as never),
		).toThrow(/management\.pluginGroups must be an array/)
	})

	it('advertises Vault only when its optional capability is installed', async () => {
		const host = createRuntimeHost({ workbench: false, management: {}, vault: {} })
		try {
			const target = new RuntimeManagementTargetImpl(host.ctx)
			expect(target.describe().protocol.capabilities).toContain('vault')
			await expect(target.securityOverview()).resolves.toMatchObject({
				vault: { enabled: true },
			})
		} finally {
			await host.dispose()
		}
	})
})
