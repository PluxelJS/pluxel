import { describe, expect, it } from 'vitest'
import { ForkablePlugin, Plugin } from '@pluxel/test'
import { LoaderService } from '@pluxel/runtime/services'
import { EXTRA_BASE_PROVIDERS, EXTRA_FORKS } from '../../src/services/runtime/loader/selection'
import { createHmrTestContext } from '../support/hmr-context'

describe('base provider selection', () => {
	it('self-heals when baseProviders points to a fork id', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		abstract class Abs extends ForkablePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		// Persist an invalid selection: base points to a fork id.
		ctx.configService.setExtra(EXTRA_BASE_PROVIDERS, { Abs: 'Impl#f1' })
		ctx.configService.setExtra(EXTRA_FORKS, { Impl: ['f1'] })

		// Enable both the provider and the fork.
		ctx.configService.enableInConfig('Impl', 'Impl#f1')

		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { Impl })
		{
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		// Base token must still resolve/runs (selection should not break DI).
		expect(core.registry.isRunning(Abs)).toBe(true)
	})
})
