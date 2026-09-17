import { expect, it } from 'vitest'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { RuntimeManagementTargetImpl } from '@pluxel/management/internal/services/management/RuntimeManagementTarget'
import { VaultAdminPlugin } from '../src/index.ts'
import { VaultWorkbench } from '../src/workbench.ts'

it('withdraws its View without withdrawing host Vault management', async () => {
	await using host = await createRuntimeInternalTestHost({
		workbench: { enabled: true },
		vault: {},
	})
	await host.start(VaultAdminPlugin)
	const management = new RuntimeManagementTargetImpl(host.ctx)
	const open = () =>
		host.workbench.open({
			target: VaultAdminPlugin,
			entry: VaultWorkbench.overview,
			principal: { provider: 'local', subject: 'local' },
			location: '/vault',
		})
	using _opened = await open()
	expect(await management.securityOverview()).toMatchObject({ vault: { enabled: true } })
	await host.stop(VaultAdminPlugin)
	await expect(open()).rejects.toThrow(/running|available|publication|entry/i)
	expect(await management.securityOverview()).toMatchObject({ vault: { enabled: true } })
})

it('can run headless but requires the Vault capability', async () => {
	await using headless = await createRuntimeInternalTestHost({ workbench: false, vault: {} })
	await headless.start(VaultAdminPlugin)
	expect(headless.isRunning(VaultAdminPlugin)).toBe(true)
	await using absent = await createRuntimeInternalTestHost({ workbench: false, vault: false })
	await expect(absent.start(VaultAdminPlugin)).rejects.toThrow(/Vault|start|lifecycle/i)
})
