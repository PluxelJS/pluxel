import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/runtime/test'
import { getStatusOverview } from '../../../runtime/src/api/features/pluginStatus/service'
import { createHmrTestContext } from '../support/hmr-context'

describe('pluginStatus forks', () => {
	it('includes fork plugins from runtime and from catalog', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class DemoWorker extends ForkablePlugin {}
		Plugin({ name: 'DemoWorker' })(DemoWorker)

		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { DemoWorker })
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		// Create + start a runtime fork (not declared in loader registry map).
		const ForkA = core.registry.fork(DemoWorker, 'aaa')
		await loader.api.control.enable('DemoWorker#aaa', ForkA)
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
		}

		// Persist another fork in the catalog, without starting it.
		ctx.runtimeState.update((draft) => {
			draft.forks = { DemoWorker: ['bbb'] }
		})

		const overview = getStatusOverview(ctx)
		const names = overview.statuses.map((s) => s?.name).filter(Boolean)

		expect(names).toContain('DemoWorker')
		expect(names).toContain('DemoWorker#aaa')
		expect(names).toContain('DemoWorker#bbb')
	})

	it('enabling the same plugin twice is idempotent', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Alpha extends BasePlugin {}
		Plugin({ name: 'Alpha' })(Alpha)

		// Load module (does not auto-enable without config).
		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { Alpha })
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		// Duplicate enable calls should not throw or unregister.
		await loader.api.control.enable('Alpha', Alpha)
		await loader.api.control.enable('Alpha', Alpha)
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
		}

		expect(core.registry.isRunning(Alpha)).toBe(true)
	})
})
