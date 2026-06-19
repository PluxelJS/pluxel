import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { LoaderService } from '../../../runtime-dynamic/src/services'
import { EXTRA_DEP_OVERRIDES } from '../../../runtime-dynamic/src/loader/selection'
import { createHmrTestContext } from '../support/hmr-context'

type HmrCore = ReturnType<typeof createHmrTestContext>['core']
type RuntimeUpdate = ReturnType<HmrCore['registry']['beginUpdate']>
type RuntimeBatch = ReturnType<LoaderService['beginBatch']>

function definePlugin<T extends new (...args: any[]) => BasePlugin>(
	ctor: T,
	meta: Parameters<typeof Plugin>[0],
	paramTypes: unknown[] = [],
): T {
	if (paramTypes.length > 0) {
		;(Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void })
			.defineMetadata?.('design:paramtypes', paramTypes, ctor)
	}
	Plugin(meta)(ctor)
	return ctor
}

function beginRuntimeBatch(core: HmrCore, loader: LoaderService) {
	const runtimeUpdate = core.registry.beginUpdate({ reason: 'hmr' })
	return {
		runtimeUpdate,
		batch: loader.beginBatch({ runtimeUpdate }),
	}
}

async function commitBatch(runtimeUpdate: RuntimeUpdate, batch: RuntimeBatch) {
	const res = await runtimeUpdate.commit({ rollbackOnFailure: false })
	expect(res).toMatchObject({ ok: true })
	batch.commit()
}

describe('LoaderService HMR lifecycle', () => {
	it('resolves ctor-param tokens by plugin id across HMR ctor identity mismatches', async () => {
		const { core, ctx } = createHmrTestContext()
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)

		class Dep extends BasePlugin {}
		definePlugin(Dep, { name: 'Dep' })

		class DepShadow extends BasePlugin {}
		definePlugin(DepShadow, { name: 'Dep' })

		class Consumer extends BasePlugin {
			constructor(_dep: DepShadow) {
				super()
			}
		}
		definePlugin(Consumer, { name: 'Consumer' }, [DepShadow])
		setParamToken(Consumer, 0, DepShadow)

		await loader.preloadPlugins([Dep])
		expect(core.registry.isRunning(Dep)).toBe(true)

		{
			const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(runtimeUpdate, batch)
		}

		expect(core.registry.isRunning(Consumer)).toBe(true)
	})

	it('reports DI-cascade affected modules so HMR can restart non-reexecuted dependents', async () => {
		const { core, ctx } = createHmrTestContext()
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)
		let depSeq = 0
		let consumerSeq = 0

		class Dep extends BasePlugin {
			readonly seq = ++depSeq
		}
		definePlugin(Dep, { name: 'Dep' })

		class Consumer extends BasePlugin {
			readonly seq = ++consumerSeq

			constructor(readonly dep: Dep) {
				super()
			}
		}
		definePlugin(Consumer, { name: 'Consumer' }, [Dep])
		setParamToken(Consumer, 0, Dep)

		{
			const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
			await batch.replaceModule('Dep.ts', { Dep })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(runtimeUpdate, batch)
		}

		const firstDep = core.registry.getInstance(Dep)
		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstDep?.seq).toBe(1)
		expect(firstConsumer?.seq).toBe(1)
		expect(firstConsumer?.dep.seq).toBe(firstDep?.seq)

		class DepNext extends BasePlugin {
			readonly seq = ++depSeq
		}
		definePlugin(DepNext, { name: 'Dep' })

		const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
		await batch.replaceModule('Dep.ts', { DepNext })
		expect(new Set(batch.getAffectedModules())).toEqual(new Set(['Dep.ts', 'Consumer.ts']))
		await batch.syncModules(batch.getAffectedModules())

		await commitBatch(runtimeUpdate, batch)

		const secondDep = core.registry.getInstance(DepNext)
		const secondConsumer = core.registry.getInstance(
			loader.api.registry.getCtor('Consumer') ?? Consumer,
		)
		expect(secondDep?.seq).toBe(2)
		expect(secondConsumer?.seq).toBe(2)
		expect(secondConsumer?.dep.seq).toBe(secondDep?.seq)
		expect(secondDep).not.toBe(firstDep)
		expect(secondConsumer).not.toBe(firstConsumer)
	})

	it('rolls back loader state when core commit fails after module replacement', async () => {
		const { core, ctx } = createHmrTestContext()
		ctx.configService.enableInConfig('Dep', 'Bad')
		const loader = new LoaderService(ctx)

		class Dep extends BasePlugin {}
		definePlugin(Dep, { name: 'Dep' })

		class Bad extends BasePlugin {
			constructor(_dep: Dep) {
				super()
			}
		}
		definePlugin(Bad, { name: 'Bad' }, [Dep])
		setParamToken(Bad, 0, Dep)

		{
			const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
			await batch.replaceModule('Dep.ts', { Dep })
			await batch.replaceModule('Bad.ts', { Bad })
			await commitBatch(runtimeUpdate, batch)
		}

		abstract class MissingBase extends BasePlugin {}

		class DepBroken extends BasePlugin {
			constructor(_missing: MissingBase) {
				super()
			}
		}
		definePlugin(DepBroken, { name: 'Dep' }, [MissingBase])
		setParamToken(DepBroken, 0, MissingBase)

		const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
		await batch.replaceModule('Dep.ts', { DepBroken })
		const res = await runtimeUpdate.commit({ rollbackOnFailure: false })
		expect(res.ok).toBe(false)
		batch.rollback()
		runtimeUpdate.rollback()

		expect(loader.api.registry.getCtor('Dep')).toBe(Dep)
		expect(loader.api.registry.findModuleId('Dep')).toBe('Dep.ts')
		expect(core.registry.isRunning(Dep)).toBe(true)
	})

	it('non-batch replaceModule returns structured results and restarts affected dependents', async () => {
		const { core, ctx } = createHmrTestContext()
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)
		let depSeq = 0
		let consumerSeq = 0

		class Dep extends BasePlugin {
			readonly seq = ++depSeq
		}
		definePlugin(Dep, { name: 'Dep' })

		class Consumer extends BasePlugin {
			readonly seq = ++consumerSeq

			constructor(readonly dep: Dep) {
				super()
			}
		}
		definePlugin(Consumer, { name: 'Consumer' }, [Dep])
		setParamToken(Consumer, 0, Dep)

		expect(await loader.replaceModule('Dep.ts', { Dep })).toMatchObject({
			isAnchor: true,
			affectedModules: [],
		})
		expect(await loader.replaceModule('Consumer.ts', { Consumer })).toMatchObject({
			isAnchor: true,
			affectedModules: [],
		})
		let res = await core.registry.commit()
		expect(res.ok).toBe(true)

		class DepNext extends BasePlugin {
			readonly seq = ++depSeq
		}
		definePlugin(DepNext, { name: 'Dep' })

		const replaced = await loader.replaceModule('Dep.ts', { DepNext })
		expect(replaced.isAnchor).toBe(true)
		expect(new Set(replaced.affectedModules)).toEqual(new Set(['Dep.ts', 'Consumer.ts']))
		res = await core.registry.commit()
		expect(res.ok).toBe(true)

		const nextConsumer = core.registry.getInstance(
			loader.api.registry.getCtor('Consumer') ?? Consumer,
		)
		expect(nextConsumer?.seq).toBe(2)
		expect(nextConsumer?.dep.seq).toBe(2)
	})

	it('applies persisted dependency overrides across HMR reloads', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)
		let depBSeq = 0
		let consumerSeq = 0

		class DepA extends BasePlugin {
			readonly kind = 'A'
		}
		definePlugin(DepA, { name: 'DepA' })

		class DepB extends BasePlugin {
			readonly kind = 'B'
			readonly seq = ++depBSeq
		}
		definePlugin(DepB, { name: 'DepB' })

		class Consumer extends BasePlugin {
			readonly seq = ++consumerSeq

			constructor(readonly dep: DepA) {
				super()
			}
		}
		definePlugin(Consumer, { name: 'Consumer' }, [DepA])
		setParamToken(Consumer, 0, DepA)

		ctx.configService.enableInConfig('DepA', 'DepB', 'Consumer')
		ctx.configService.setExtra(EXTRA_DEP_OVERRIDES, { Consumer: { 0: 'DepB' } })

		{
			const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
			await batch.replaceModule('DepA.ts', { DepA })
			await batch.replaceModule('DepB.ts', { DepB })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(runtimeUpdate, batch)
		}

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.seq).toBe(1)
		expect(firstConsumer?.dep.kind).toBe('B')
		expect((firstConsumer?.dep as InstanceType<typeof DepB> | undefined)?.seq).toBe(1)

		class DepBNext extends BasePlugin {
			readonly kind = 'B'
			readonly seq = ++depBSeq
		}
		definePlugin(DepBNext, { name: 'DepB' })

		const { runtimeUpdate, batch } = beginRuntimeBatch(core, loader)
		await batch.replaceModule('DepB.ts', { DepBNext })
		expect(new Set(batch.getAffectedModules())).toEqual(new Set(['DepB.ts', 'Consumer.ts']))
		await batch.syncModules(batch.getAffectedModules())
		await commitBatch(runtimeUpdate, batch)

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.seq).toBe(2)
		expect(nextConsumer?.dep.kind).toBe('B')
		expect((nextConsumer?.dep as InstanceType<typeof DepBNext> | undefined)?.seq).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
	})

	it('closes batch transactions after commit or rollback', async () => {
		const { ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		class Anchor extends BasePlugin {}
		definePlugin(Anchor, { name: 'Anchor' })

		const committed = loader.beginBatch()
		await committed.replaceModule('Committed.ts', { Anchor })
		expect(committed.getAffectedModules()).toEqual([])
		committed.commit()
		expect(committed.getAffectedModules()).toEqual([])
		await expect(committed.replaceModule('Committed.ts', { Anchor })).rejects.toThrow(
			/LoaderBatch is already closed/,
		)

		const rolledBack = loader.beginBatch()
		rolledBack.rollback()
		await expect(rolledBack.syncModules(['Committed.ts'])).rejects.toThrow(
			/LoaderBatch is already closed/,
		)
	})
})
