import { createTestHost } from '@pluxel/test'
import { vault } from '@pluxel/services/vault'
import { standardServices } from '@pluxel/services'
import { expect, it } from 'vitest'
import { RuntimeManagementTargetImpl } from '@pluxel/services/management/internal/test'
import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { VaultWorkbench } from '../src/plugins/vault/workbench.ts'

it('withdraws its View without withdrawing host Vault management', async () => {
	await using host = await createTestHost({
		workbench: true,
		services: [...standardServices(), vault()],
	})
	const plugin = await host.start(VaultAdminPlugin.nodeAddress())
	const management = new RuntimeManagementTargetImpl(plugin.ctx.root)
	const open = () =>
		host.workbench.open({
			target: VaultAdminPlugin.nodeAddress(),
			entry: VaultWorkbench.overview,
			principal: { provider: 'local', subject: 'local' },
			location: '/vault',
		})
	using _opened = await open()
	expect(await management.securityOverviewDto()).toMatchObject({ vault: { enabled: true } })
	await host.stop(VaultAdminPlugin.nodeAddress())
	await expect(open()).rejects.toThrow(/running|available|publication|entry/i)
	expect(await management.securityOverviewDto()).toMatchObject({ vault: { enabled: true } })
})

it('can run headless but requires the Vault capability', async () => {
	await using headless = await createTestHost({
		services: [...standardServices(), vault()],
	})
	await headless.start(VaultAdminPlugin.nodeAddress())
	expect(headless.isRunning(VaultAdminPlugin.nodeAddress())).toBe(true)
	await using absent = await createTestHost({
		services: standardServices(),
	})
	await expect(absent.start(VaultAdminPlugin.nodeAddress())).rejects.toThrow(
		/Vault|start|lifecycle/i,
	)
})
