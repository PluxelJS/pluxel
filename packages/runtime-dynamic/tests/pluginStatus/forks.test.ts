import { describe, expect, it } from 'vitest'
import {
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/runtime/test'
import { getStatusOverview } from '../../../runtime/src/api/features/pluginStatus/service'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestPlugin } from '../support/lowered-plugin'

function hasAddress(
	addresses: readonly PluginNodeAddressSnapshot[],
	target: PluginNodeAddressSnapshot,
): boolean {
	return addresses.some((address) => pluginNodeAddressEqual(address, target))
}

describe('pluginStatus forks', () => {
	it('includes structured runtime and persisted fork addresses', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Demo worker' })
		class DemoWorker extends ForkablePlugin {}
		lowerTestPlugin(DemoWorker)

		await ctx.loader.replaceModule('A.ts', { DemoWorker })
		const base = pluginNodeAddressOf(DemoWorker)
		const runtimeFork = { definition: base.definition, instance: 'fork', forkId: 'aaa' } as const
		const persistedFork = { definition: base.definition, instance: 'fork', forkId: 'bbb' } as const
		const RuntimeFork = core.registry.fork(DemoWorker, 'aaa')
		await ctx.loader.api.control.enable(runtimeFork, RuntimeFork)
		const committed = await core.registry.commit()
		expect(committed.ok).toBe(true)

		ctx.runtimeState.update((draft) => {
			draft.forks = [{ definition: base.definition, forkIds: ['bbb'] }]
		})

		const addresses = getStatusOverview(ctx).statuses.map((status) => status.address)
		expect(hasAddress(addresses, base)).toBe(true)
		expect(hasAddress(addresses, runtimeFork)).toBe(true)
		expect(hasAddress(addresses, persistedFork)).toBe(true)
	})

	it('enabling the same address twice is idempotent', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Alpha' })
		class Alpha extends BasePlugin {}
		lowerTestPlugin(Alpha)

		await ctx.loader.replaceModule('A.ts', { Alpha })
		const address = pluginNodeAddressOf(Alpha)
		await ctx.loader.api.control.enable(address, Alpha)
		await ctx.loader.api.control.enable(address, Alpha)
		const committed = await core.registry.commit()
		expect(committed.ok).toBe(true)
		expect(core.registry.isRunning(Alpha)).toBe(true)
	})
})
