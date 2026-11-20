import { defineServiceRef } from '@pluxel/core'
import { CatalogLayout, Management } from '@pluxel/services/management/service'
import { AdminAccess } from '@pluxel/services/management/access'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import { RuntimeManagementService } from '../../src/management/services/RuntimeManagementService'

import { RuntimeManagementTargetImpl } from '../../src/management/services/management/RuntimeManagementTarget.ts'
import { RUNTIME_SESSION_PATH } from '../../src/management/web/session/protocol.ts'

const AdminAccessRef = defineServiceRef<AdminAccess>()
const ManagementRef = defineServiceRef<Management>()
const CatalogLayoutRef = defineServiceRef<CatalogLayout>()
describe('runtime Management plane installation', () => {
	it('keeps local helpers off the RPC surface and rejects capability-bearing producer DTOs', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false, management: true })

		const target = new RuntimeManagementTargetImpl(host.ctx)
		using remote = new RpcStub(target)
		await expect(
			(remote as unknown as { logPolicy(): Promise<unknown> }).logPolicy(),
		).rejects.toThrow(/logPolicy/)
		const valid = target.describeDto()
		const describeSnapshot = vi
			.spyOn(RuntimeManagementService.prototype, 'describe')
			.mockReturnValue({
				...valid,
				application: { product: new RpcTarget() },
			} as unknown as ReturnType<RuntimeManagementService['describe']>)
		try {
			expect(() => target.describeDto()).toThrow(/plain object/)
		} finally {
			describeSnapshot.mockRestore()
		}
	})

	it('allocates no Management endpoint or backend when Management and Workbench are disabled', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false })

		expect(host.ctx.root.service(AdminAccessRef)).toBeUndefined()
		expect(host.ctx.root.service(ManagementRef)).toBeUndefined()
		expect(host.ctx.root.service(CatalogLayoutRef)).toBeUndefined()
		const response = await host.http.fetch(
			new Request(`http://runtime.test${RUNTIME_SESSION_PATH}`, {
				headers: { connection: 'upgrade', upgrade: 'websocket' },
			}),
		)
		expect(response.status).toBe(404)
	})

	it('does not wait indefinitely for an unread in-process response during host disposal', async () => {
		await using host = await createServiceInternalTestHost({ workbench: false, management: true })
		const response = await host.http.fetch(
			new Request(`http://runtime.test${RUNTIME_SESSION_PATH}`),
		)
		expect(response.status).toBe(400)
		expect(response.body).not.toBeNull()
		await expect(host.dispose()).resolves.toBeUndefined()
	})

	it('rejects unsupported management configuration fields', async () => {
		for (const management of [{ unknownField: true }, { enabled: true }]) {
			await expect(
				createServiceInternalTestHost({ workbench: false, management } as never),
			).rejects.toThrow(/management must be booleans/)
		}
	})
})
