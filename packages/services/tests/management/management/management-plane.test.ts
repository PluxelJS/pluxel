import { standardServices } from '@pluxel/services'
import { vault } from '@pluxel/services/vault'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import { RuntimeManagementService } from '../../../src/management/services/RuntimeManagementService'

import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import { RUNTIME_SESSION_PATH } from '../../../src/management/web/session/protocol.ts'

describe('runtime Management plane installation', () => {
	it('installs headless Management as a capability with no dynamic HTTP API', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false, management: true })

		expect(host.ctx.workbench).toBeUndefined()
		expect(host.ctx.root.adminAccess).toBeDefined()
		expect(host.ctx.root.runtimeManagement).toBeDefined()
		expect(host.ctx.root.pluginCatalogLayout).toBeDefined()

		const target = new RuntimeManagementTargetImpl(host.ctx)
		expect(target.describeDto()).toMatchObject({
			protocol: { name: 'pluxel.management', major: 7 },
			workbench: { enabled: false },
		})
		expect(target.describeDto().protocol.capabilities).not.toContain('vault')
		await expect(target.pluginCatalogDto()).resolves.toMatchObject({
			plugins: [],
			sections: [],
			summary: { total: 0 },
		})
		await expect(target.securityOverviewDto()).resolves.toMatchObject({
			vault: { enabled: false },
		})

		const oldDynamicPath = await host.http.fetch(
			new Request('http://runtime.test/__pluxel/runtime/meta'),
		)
		expect(oldDynamicPath.status).toBe(404)
		expect(await oldDynamicPath.text()).toContain('Not Found')
	})

	it('keeps local helpers off the RPC surface and rejects capability-bearing producer DTOs', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false, management: true })

		const target = new RuntimeManagementTargetImpl(host.ctx)
		using remote = new RpcStub(target)
		const names = Object.getOwnPropertyNames(RuntimeManagementTargetImpl.prototype)
		expect(names.filter((name) => name !== 'constructor' && !name.endsWith('Dto'))).toEqual([
			'followRuntimeUpdates',
			'followLogs',
		])
		await expect(
			(remote as unknown as { logPolicy(): Promise<unknown> }).logPolicy(),
		).rejects.toThrow(/logPolicy/)
		const valid = target.describeDto()
		const describeSnapshot = vi
			.spyOn(RuntimeManagementService.prototype, 'describe')
			.mockReturnValue(valid)
		try {
			expect(target.describeDto()).toBe(valid)
			describeSnapshot.mockReturnValue({
				...valid,
				application: { product: new RpcTarget() },
			} as unknown as ReturnType<RuntimeManagementService['describe']>)
			expect(() => target.describeDto()).toThrow(/plain object/)
		} finally {
			describeSnapshot.mockRestore()
		}
	})

	it('allocates no Management endpoint or backend when Management and Workbench are disabled', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false })

		expect(host.ctx.root.adminAccess).toBeUndefined()
		expect(host.ctx.root.runtimeManagement).toBeUndefined()
		expect(host.ctx.root.pluginCatalogLayout).toBeUndefined()
		const response = await host.http.fetch(
			new Request(`http://runtime.test${RUNTIME_SESSION_PATH}`, {
				headers: { connection: 'upgrade', upgrade: 'websocket' },
			}),
		)
		expect(response.status).toBe(404)
	})

	it('does not wait indefinitely for an unread in-process response during host disposal', async () => {
		const host = await createServiceInternalTestHost({ workbench: false, management: true })
		const response = await host.http.fetch(new Request('http://runtime.test/__pluxel/runtime/meta'))
		expect(response.status).toBe(404)
		await expect(host.dispose()).resolves.toBeUndefined()
	})

	it('rejects unsupported management configuration fields', async () => {
		for (const management of [{ unknownField: true }, { enabled: true }]) {
			await expect(
				createServiceInternalTestHost({ workbench: false, management } as never),
			).rejects.toThrow(/management must be booleans/)
		}
	})

	it('advertises Vault only when its optional capability is installed', async () => {
		await using host = await createServiceInternalTestHost({
			workbench: false,
			management: true,
			services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
		})

		const target = new RuntimeManagementTargetImpl(host.ctx)
		expect(target.describeDto().protocol.capabilities).toContain('vault')
		await expect(target.securityOverviewDto()).resolves.toMatchObject({
			vault: { enabled: true },
		})
	})
})
