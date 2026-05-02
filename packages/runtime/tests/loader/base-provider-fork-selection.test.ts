import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, setParamToken } from '@pluxel/test'
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

	it('restarts consumers that depend on a base token when the selected provider module reloads', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)
		let providerSeq = 0
		let consumerSeq = 0

		abstract class Abs extends ForkablePlugin {
			abstract readonly providerSeq: number
		}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {
			readonly providerSeq = ++providerSeq
		}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			readonly consumerSeq = ++consumerSeq

			constructor(readonly dep: Abs) {
				super()
			}
		}
		setParamToken(Consumer, 0, Abs)

		ctx.configService.enableInConfig('Impl', 'Consumer')

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Provider.ts', { Impl })
			await batch.replaceModule('Consumer.ts', { Consumer })
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.consumerSeq).toBe(1)
		expect(firstConsumer?.dep.providerSeq).toBe(1)

		@Plugin(Abs, { name: 'Impl' })
		class ImplNext extends Abs {
			readonly providerSeq = ++providerSeq
		}

		const batch = loader.beginBatch()
		await batch.replaceModule('Provider.ts', { ImplNext })
		expect(new Set(batch.listAffectedModules())).toEqual(new Set(['Provider.ts', 'Consumer.ts']))
		await loader.syncRuntimeForModules(batch.listAffectedModules())
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.consumerSeq).toBe(2)
		expect(nextConsumer?.dep.providerSeq).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
	})
})
