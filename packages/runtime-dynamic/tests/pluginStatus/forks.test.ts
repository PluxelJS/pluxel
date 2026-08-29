import { describe, expect, it } from 'vitest'
import { pluginNodeAddressEqual, pluginNodeAddressOf, type PluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import {
	readRuntimePluginStatusOverview,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
} from '@pluxel/runtime/internal'
import { requireLoaderService } from '../../src/context-plan'
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

		await requireLoaderService(ctx).replaceModule('A.ts', { DemoWorker })
		const base = pluginNodeAddressOf(DemoWorker)
		const runtimeFork = { definition: base.definition, variant: 'fork', forkId: 'aaa' } as const
		const persistedFork = { definition: base.definition, variant: 'fork', forkId: 'bbb' } as const
		await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: base.definition, forkId: 'aaa' },
				{ type: 'ensure-fork', definition: base.definition, forkId: 'bbb' },
				{ type: 'set-auto-start', node: runtimeFork, autoStart: true },
			),
		)

		const statusOverview = await readRuntimePluginStatusOverview(ctx)
		const addresses = statusOverview.statuses.map((status) => status.address)
		expect(hasAddress(addresses, base)).toBe(true)
		expect(hasAddress(addresses, runtimeFork)).toBe(true)
		expect(hasAddress(addresses, persistedFork)).toBe(true)
	})

	it('starting the same address twice is idempotent', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class Alpha extends BasePlugin {}
		lowerTestPlugin(Alpha)

		await requireLoaderService(ctx).replaceModule('A.ts', { Alpha })
		const address = pluginNodeAddressOf(Alpha)
		await requireLoaderService(ctx).api.control.start(address)
		await requireLoaderService(ctx).api.control.start(address)
		expect(requirePluginService(ctx).isRunning(address)).toBe(true)
	})
})
