import { vault } from '@pluxel/services/vault'
import { standardServices } from '@pluxel/services'
import { expect, it } from 'vitest'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { RuntimeManagementTargetImpl } from '@pluxel/management/internal/services/management/RuntimeManagementTarget'
import { VaultAdminPlugin } from '../src/index.ts'
import { VaultWorkbench } from '../src/workbench.ts'

it('withdraws its View without withdrawing host Vault management', async () => {
	await using host = await createServiceInternalTestHost({
		workbench: true,
		services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
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
	await using headless = await createServiceInternalTestHost({
		workbench: false,
		services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
	})
	await headless.start(VaultAdminPlugin)
	expect(headless.isRunning(VaultAdminPlugin)).toBe(true)
	await using absent = await createServiceInternalTestHost({ workbench: false })
	await expect(absent.start(VaultAdminPlugin)).rejects.toThrow(/Vault|start|lifecycle/i)
})
