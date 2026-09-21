import { createTestHost } from '@pluxel/test'
import { vault } from '@pluxel/services/vault'
import { standardServices } from '@pluxel/services'
import { expect, it } from 'vitest'
import { RuntimeManagementTargetImpl } from '@pluxel/services/management/internal/test'
import { VaultAdminPlugin } from '../src/index.ts'
import { VaultWorkbench } from '../src/workbench.ts'

it('withdraws its View without withdrawing host Vault management', async () => {
	await using host = await createTestHost({
		workbench: true,
		services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
	})
	const plugin = await host.start(VaultAdminPlugin)
	const management = new RuntimeManagementTargetImpl(plugin.ctx.root)
	const open = () =>
		host.workbench.open({
			target: VaultAdminPlugin,
			entry: VaultWorkbench.overview,
			principal: { provider: 'local', subject: 'local' },
			location: '/vault',
		})
	using _opened = await open()
	expect(await management.securityOverviewDto()).toMatchObject({ vault: { enabled: true } })
	await host.stop(VaultAdminPlugin)
	await expect(open()).rejects.toThrow(/running|available|publication|entry/i)
	expect(await management.securityOverviewDto()).toMatchObject({ vault: { enabled: true } })
})

it('can run headless but requires the Vault capability', async () => {
	await using headless = await createTestHost({
		services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
	})
	await headless.start(VaultAdminPlugin)
	expect(headless.isRunning(VaultAdminPlugin)).toBe(true)
	await using absent = await createTestHost({
		services: standardServices({ persistence: { mode: 'memory' } }),
	})
	await expect(absent.start(VaultAdminPlugin)).rejects.toThrow(/Vault|start|lifecycle/i)
})
