import { describe, expect, it } from 'vitest'
import { pluginNodeAddressEqual, pluginNodeAddressOf, type PluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { requireRuntimePluginGraphCoordinator, runtimeStatePatch } from '@pluxel/runtime/internal'
import { getStatusOverview } from '../../../runtime/src/api/features/pluginStatus/service'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestPlugin } from '../support/lowered-plugin'

function hasAddress(addresses: readonly PluginNodeAddress[], target: PluginNodeAddress): boolean {
	return addresses.some((address) => pluginNodeAddressEqual(address, target))
}

describe('pluginStatus forks', () => {
	it('includes structured runtime and persisted fork addresses', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Demo worker', forkable: true })
		class DemoWorker extends BasePlugin {}
		lowerTestPlugin(DemoWorker)

		await ctx.loader.replaceModule('A.ts', { DemoWorker })
		const base = pluginNodeAddressOf(DemoWorker)
		const runtimeFork = { definition: base.definition, variant: 'fork', forkId: 'aaa' } as const
		const persistedFork = { definition: base.definition, variant: 'fork', forkId: 'bbb' } as const
		await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: base.definition, forkId: 'aaa' },
				{ type: 'ensure-fork', definition: base.definition, forkId: 'bbb' },
				{ type: 'set-enabled', node: runtimeFork, enabled: true },
			),
		)

		const addresses = getStatusOverview(ctx).statuses.map((status) => status.address)
		expect(hasAddress(addresses, base)).toBe(true)
		expect(hasAddress(addresses, runtimeFork)).toBe(true)
		expect(hasAddress(addresses, persistedFork)).toBe(true)
	})

	it('enabling the same address twice is idempotent', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class Alpha extends BasePlugin {}
		lowerTestPlugin(Alpha)

		await ctx.loader.replaceModule('A.ts', { Alpha })
		const address = pluginNodeAddressOf(Alpha)
		await ctx.loader.api.control.enable(address)
		await ctx.loader.api.control.enable(address)
		expect(requirePluginService(ctx).isRunning(address)).toBe(true)
	})
})
