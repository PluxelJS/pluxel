import { vault } from '@pluxel/services/vault'
import { standardServices } from '@pluxel/services'
import { expect, it } from 'vitest'
import { createServiceTestHost } from '@pluxel/services/test'
import { createWorkbenchTestHost } from '@pluxel/workbench/test'
import { RuntimeManagementTargetImpl } from '@pluxel/services/management/internal/test'
import { VaultAdminPlugin } from '../src/index.ts'
import { VaultWorkbench } from '../src/workbench.ts'

it('withdraws its View without withdrawing host Vault management', async () => {
	await using host = await createWorkbenchTestHost({
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
	expect(await management.securityOverview()).toMatchObject({ vault: { enabled: true } })
	await host.stop(VaultAdminPlugin)
	await expect(open()).rejects.toThrow(/running|available|publication|entry/i)
	expect(await management.securityOverview()).toMatchObject({ vault: { enabled: true } })
})

it('can run headless but requires the Vault capability', async () => {
	await using headless = await createServiceTestHost({
		services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
	})
	await headless.start(VaultAdminPlugin)
	expect(headless.isRunning(VaultAdminPlugin)).toBe(true)
	await using absent = await createServiceTestHost()
	await expect(absent.start(VaultAdminPlugin)).rejects.toThrow(/Vault|start|lifecycle/i)
})
