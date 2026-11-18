import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { expect, it } from 'vitest'
import { RuntimeManagementTargetImpl } from '@pluxel/services/management/internal/test'
import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { VaultWorkbench } from '../src/plugins/vault/workbench.ts'

it('withdraws its View without withdrawing host Vault management', async () => {
	await using host = await createTestHost({
		workbench: true,
		services: [elysia(), commands(), nodeModules(), workers()],
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

it('can run headless with only the built-in Vault capability', async () => {
	await using headless = await createTestHost({ services: [] })
	await headless.start(VaultAdminPlugin.nodeAddress())
	expect(headless.isRunning(VaultAdminPlugin.nodeAddress())).toBe(true)
})
