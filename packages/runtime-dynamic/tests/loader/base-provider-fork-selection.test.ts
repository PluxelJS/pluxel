import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { createHmrTestContext } from '../support/hmr-context'
import { enablePlugins } from '../support/runtime-state'

async function commitBatch(
	core: ReturnType<typeof createHmrTestContext>['core'],
	batch: { commit(): void },
) {
	const res = await core.registry.commit()
	expect(res.ok).toBe(true)
	batch.commit()
}

function defineParamTypes(ctor: unknown, paramTypes: unknown[]) {
	;(
		Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void }
	).defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

describe('base provider selection', () => {
	it('self-heals when baseProviders points to a fork id', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		abstract class Abs extends ForkablePlugin {}

		class Impl extends Abs {}
		Plugin(Abs, { name: 'Impl' })(Impl)

		// Persist an invalid selection: base points to a fork id.
		ctx.runtimeState.update((draft) => {
			draft.baseProviders = { Abs: 'Impl#f1' }
			draft.forks = { Impl: ['f1'] }
		})

		// Enable both the provider and the fork.
		enablePlugins(ctx, 'Impl', 'Impl#f1')

		const batch = loader.beginBatch()
		await batch.replaceModule('A.ts', { Impl })
		await commitBatch(core, batch)

		// Base token must still resolve/runs (selection should not break DI).
		expect(core.registry.isRunning(Abs)).toBe(true)
	})

	it('restarts consumers that depend on a base token when the selected provider module reloads', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader
		let providerSeq = 0
		let consumerSeq = 0

		abstract class Abs extends ForkablePlugin {
			abstract readonly providerSeq: number
		}

		class Impl extends Abs {
			readonly providerSeq = ++providerSeq
		}
		Plugin(Abs, { name: 'Impl' })(Impl)

		class Consumer extends BasePlugin {
			readonly consumerSeq = ++consumerSeq

			constructor(readonly dep: Abs) {
				super()
			}
		}
		defineParamTypes(Consumer, [Abs])
		Plugin({ name: 'Consumer' })(Consumer)
		setParamToken(Consumer, 0, Abs)

		enablePlugins(ctx, 'Impl', 'Consumer')

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Provider.ts', { Impl })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(core, batch)
		}

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.consumerSeq).toBe(1)
		expect(firstConsumer?.dep.providerSeq).toBe(1)

		class ImplNext extends Abs {
			readonly providerSeq = ++providerSeq
		}
		Plugin(Abs, { name: 'Impl' })(ImplNext)

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
		const loader = ctx.loader
		let providerSeq = 0
		let consumerSeq = 0

		class Worker extends ForkablePlugin {
			readonly providerSeq = ++providerSeq
		}
		Plugin({ name: 'Worker' })(Worker)

		const WorkerFork = core.registry.fork(Worker, 'f1')

		class Consumer extends BasePlugin {
			readonly consumerSeq = ++consumerSeq

			constructor(readonly dep: InstanceType<typeof Worker>) {
				super()
			}
		}
		defineParamTypes(Consumer, [WorkerFork])
		Plugin({ name: 'Consumer' })(Consumer)
		setParamToken(Consumer, 0, WorkerFork)

		ctx.runtimeState.update((draft) => {
			draft.forks = { Worker: ['f1'] }
		})
		enablePlugins(ctx, 'Worker#f1', 'Consumer')

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Provider.ts', { Worker })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(core, batch)
		}

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.consumerSeq).toBe(1)
		expect(firstConsumer?.dep.providerSeq).toBe(1)

		class WorkerNext extends ForkablePlugin {
			readonly providerSeq = ++providerSeq
		}
		Plugin({ name: 'Worker' })(WorkerNext)

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
