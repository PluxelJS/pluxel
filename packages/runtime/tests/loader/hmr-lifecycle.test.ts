import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import { LoaderService } from '../../../runtime-loader/src/services'
import { EXTRA_DEP_OVERRIDES } from '../../../runtime-loader/src/loader/selection'
import { createHmrTestContext } from '../support/hmr-context'

async function commitBatch(
	core: ReturnType<typeof createHmrTestContext>['core'],
	batch: { commit(): void },
) {
	const res = await core.registry.commit()
	expect(res.ok).toBe(true)
	batch.commit()
}

describe('LoaderService HMR lifecycle', () => {
	it('normalizes ctor-param tokens by plugin id across HMR ctor identity mismatches', async () => {
		const { core, ctx } = createHmrTestContext()
		const warns: unknown[] = []
		;(ctx as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger.warn = (
			...args: unknown[]
		) => warns.push(args)
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Dep' })
		class Dep extends BasePlugin {}

		@Plugin({ name: 'Dep' })
		class DepShadow extends BasePlugin {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: DepShadow) {
				super()
			}
		}
		setParamToken(Consumer, 0, DepShadow)

		await loader.preloadPlugins([Dep])
		expect(core.registry.isRunning(Dep)).toBe(true)

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(core, batch)
		}

		expect(core.registry.isRunning(Consumer)).toBe(true)
		expect(warns).toHaveLength(1)
		expect((warns[0] as unknown[])[0]).toBe(
			'依赖注入 token 已归一化：检测到同 id 不同 ctor 引用（建议检查 bridge/导入路径）',
		)
		expect((warns[0] as unknown[])[1]).toMatchObject({
			moduleId: 'Consumer.ts',
			consumer: 'Consumer',
		})
	})

	it('reports DI-cascade affected modules so HMR can restart non-reexecuted dependents', async () => {
		const { core, ctx } = createHmrTestContext()
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)
		let depSeq = 0
		let consumerSeq = 0

		@Plugin({ name: 'Dep' })
		class Dep extends BasePlugin {
			readonly seq = ++depSeq
		}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			readonly seq = ++consumerSeq

			constructor(readonly dep: Dep) {
				super()
			}
		}
		setParamToken(Consumer, 0, Dep)

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Dep.ts', { Dep })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(core, batch)
		}

		const firstDep = core.registry.getInstance(Dep)
		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstDep?.seq).toBe(1)
		expect(firstConsumer?.seq).toBe(1)
		expect(firstConsumer?.dep.seq).toBe(firstDep?.seq)

		@Plugin({ name: 'Dep' })
		class DepNext extends BasePlugin {
			readonly seq = ++depSeq
		}

		const batch = loader.beginBatch()
		await batch.replaceModule('Dep.ts', { DepNext })
		expect(new Set(batch.getAffectedModules())).toEqual(new Set(['Dep.ts', 'Consumer.ts']))
		await batch.syncModules(batch.getAffectedModules())

		await commitBatch(core, batch)

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

		@Plugin({ name: 'Dep' })
		class Dep extends BasePlugin {}

		@Plugin({ name: 'Bad' })
		class Bad extends BasePlugin {
			constructor(_dep: Dep) {
				super()
			}
		}
		setParamToken(Bad, 0, Dep)

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Dep.ts', { Dep })
			await batch.replaceModule('Bad.ts', { Bad })
			await commitBatch(core, batch)
		}

		abstract class MissingBase extends BasePlugin {}

		@Plugin({ name: 'Dep' })
		class DepBroken extends BasePlugin {
			constructor(_missing: MissingBase) {
				super()
			}
		}
		setParamToken(DepBroken, 0, MissingBase)

		const batch = loader.beginBatch()
		await batch.replaceModule('Dep.ts', { DepBroken })
		const res = await core.registry.commit()
		expect(res.ok).toBe(false)
		batch.rollback()
		core.registry.resetDraft()

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

		@Plugin({ name: 'Dep' })
		class Dep extends BasePlugin {
			readonly seq = ++depSeq
		}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			readonly seq = ++consumerSeq

			constructor(readonly dep: Dep) {
				super()
			}
		}
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

		@Plugin({ name: 'Dep' })
		class DepNext extends BasePlugin {
			readonly seq = ++depSeq
		}

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

		@Plugin({ name: 'DepA' })
		class DepA extends BasePlugin {
			readonly kind = 'A'
		}

		@Plugin({ name: 'DepB' })
		class DepB extends BasePlugin {
			readonly kind = 'B'
			readonly seq = ++depBSeq
		}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			readonly seq = ++consumerSeq

			constructor(readonly dep: DepA) {
				super()
			}
		}
		setParamToken(Consumer, 0, DepA)

		ctx.configService.enableInConfig('DepA', 'DepB', 'Consumer')
		ctx.configService.setExtra(EXTRA_DEP_OVERRIDES, { Consumer: { 0: 'DepB' } })

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('DepA.ts', { DepA })
			await batch.replaceModule('DepB.ts', { DepB })
			await batch.replaceModule('Consumer.ts', { Consumer })
			await commitBatch(core, batch)
		}

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.seq).toBe(1)
		expect(firstConsumer?.dep.kind).toBe('B')
		expect((firstConsumer?.dep as InstanceType<typeof DepB> | undefined)?.seq).toBe(1)

		@Plugin({ name: 'DepB' })
		class DepBNext extends BasePlugin {
			readonly kind = 'B'
			readonly seq = ++depBSeq
		}

		const batch = loader.beginBatch()
		await batch.replaceModule('DepB.ts', { DepBNext })
		expect(new Set(batch.getAffectedModules())).toEqual(new Set(['DepB.ts', 'Consumer.ts']))
		await batch.syncModules(batch.getAffectedModules())
		await commitBatch(core, batch)

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.seq).toBe(2)
		expect(nextConsumer?.dep.kind).toBe('B')
		expect((nextConsumer?.dep as InstanceType<typeof DepBNext> | undefined)?.seq).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
	})

	it('closes batch transactions after commit or rollback', async () => {
		const { ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Anchor' })
		class Anchor extends BasePlugin {}

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
