import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { LoaderService } from '../../../runtime-loader/src/services'
import { EXTRA_BASE_PROVIDERS, EXTRA_FORKS } from '../../../runtime-loader/src/loader/selection'
import { createHmrTestContext } from '../support/hmr-context'

async function commitBatch(
	core: ReturnType<typeof createHmrTestContext>['core'],
	batch: { commit(): void },
) {
	const res = await core.registry.commit()
	expect(res.ok).toBe(true)
	batch.commit()
}

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
		await commitBatch(core, batch)

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
			await commitBatch(core, batch)
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
		expect(new Set(batch.getAffectedModules())).toEqual(new Set(['Provider.ts', 'Consumer.ts']))
		await batch.syncModules(batch.getAffectedModules())
		await commitBatch(core, batch)

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.consumerSeq).toBe(2)
		expect(nextConsumer?.dep.providerSeq).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
	})

	it('restarts consumers that depend on an enabled fork when the provider module reloads', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)
		let providerSeq = 0
		let consumerSeq = 0

		@Plugin({ name: 'Worker' })
		class Worker extends ForkablePlugin {
			readonly providerSeq = ++providerSeq
		}

		const WorkerFork = core.registry.fork(Worker, 'f1')

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			readonly consumerSeq = ++consumerSeq

			constructor(readonly dep: InstanceType<typeof Worker>) {
				super()
			}
		}
		setParamToken(Consumer, 0, WorkerFork)

		ctx.configService.setExtra(EXTRA_FORKS, { Worker: ['f1'] })
		ctx.configService.enableInConfig('Worker#f1', 'Consumer')

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Provider.ts', { Worker })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(core, batch)
		}

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.consumerSeq).toBe(1)
		expect(firstConsumer?.dep.providerSeq).toBe(1)

		@Plugin({ name: 'Worker' })
		class WorkerNext extends ForkablePlugin {
			readonly providerSeq = ++providerSeq
		}

		const batch = loader.beginBatch()
		await batch.replaceModule('Provider.ts', { WorkerNext })
		expect(new Set(batch.getAffectedModules()).has('Consumer.ts')).toBe(true)
		await batch.syncModules(batch.getAffectedModules())
		await commitBatch(core, batch)

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.consumerSeq).toBe(2)
		expect(nextConsumer?.dep.providerSeq).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
	})
})
