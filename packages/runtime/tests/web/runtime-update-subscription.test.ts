import { RpcStub } from 'capnweb'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { expect, it } from 'vitest'
import { PluginRecentUpdateTracker } from '../../src/internal/recent-update'
import { installRuntimeRouteCapabilities } from '../../src/runtime/capabilities'
import { RuntimeManagementTargetImpl } from '../../src/services/management/RuntimeManagementTarget'
import { createRuntimeManagementClient } from '../../src/web/client'

it('delivers the current route attempt and later failures through RPC, then releases the observer', async () => {
	const host = createRuntimeInternalTestHost({ workbench: false, management: true })
	const tracker = new PluginRecentUpdateTracker()
	const detach = installRuntimeRouteCapabilities(host.ctx, { recentUpdate: tracker })
	const management = new RpcStub(new RuntimeManagementTargetImpl(host.ctx))
	const client = createRuntimeManagementClient(management)
	const events: unknown[] = []
	let subscription: Disposable | undefined
	try {
		subscription = await client.updates.follow((snapshot) => {
			events.push(snapshot)
		})
		await expect.poll(() => events).toEqual([null])
		tracker.beginUpdate('new.ts')
		await expect.poll(() => events.length).toBe(2)
		tracker.record({
			definitionKeys: [],
			batch: {
				scope: 'application',
				outcome: 'retained-previous',
				phase: 'evaluate',
				durationMs: 7,
			},
		})
		tracker.finishUpdate({
			message: 'Missing dependency',
			file: 'new.ts',
			importChain: ['entry.ts', 'new.ts'],
		})
		await expect.poll(() => events.length).toBe(3)
		expect(events[2]).toMatchObject({
			sequence: 1,
			state: 'settled',
			error: { message: 'Missing dependency' },
		})
		expect(await client.updates.snapshot()).toEqual(events[2])
		subscription[Symbol.dispose]()
		subscription = undefined
		await new Promise((resolve) => setTimeout(resolve, 0))
		tracker.beginUpdate('new.ts')
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(events).toHaveLength(3)
	} finally {
		subscription?.[Symbol.dispose]()
		management[Symbol.dispose]()
		detach()
		await host.dispose()
	}
})
