import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, setParamToken } from '@pluxel/test'
import type { ForkablePluginConstructor } from '@pluxel/core'
import { LoaderService } from '@pluxel/runtime/services'
import {
	EXTRA_BUILTINS_KNOWN,
	EXTRA_FORKS,
	type BuiltinsKnownExtra,
	type ForksExtra,
} from '../../src/services/runtime/loader/selection'
import { createHmrTestContext } from '../support/hmr-context'

describe('LoaderService', () => {
	it('preloadPlugins supports forkable builtins (including enabled forks)', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Forky' })
		class Forky extends ForkablePlugin {}

		await loader.preloadPlugins([
			{
				plugin: Forky,
				enable: false,
				forks: ['a', { id: 'b', enable: true }, { id: 'c', enable: false }],
			},
		])

		expect(ctx.configService.isEnabledInConfig('Forky')).toBe(false)
		expect(ctx.configService.isEnabledInConfig('Forky#a')).toBe(true)
		expect(ctx.configService.isEnabledInConfig('Forky#b')).toBe(true)
		expect(ctx.configService.isEnabledInConfig('Forky#c')).toBe(false)

		const catalog = ctx.configService.getExtra(EXTRA_FORKS) as ForksExtra | undefined
		expect(catalog?.Forky?.slice().sort()).toEqual(['a', 'b', 'c'])

		const ForkA = core.registry.fork(Forky as unknown as ForkablePluginConstructor, 'a')
		const ForkB = core.registry.fork(Forky as unknown as ForkablePluginConstructor, 'b')
		expect(core.registry.isRunning(Forky)).toBe(false)
		expect(core.registry.isRunning(ForkA)).toBe(true)
		expect(core.registry.isRunning(ForkB)).toBe(true)

		// Fork source should resolve to the base plugin module id.
		expect(loader.api.registry.findModuleId('Forky#a')).toBe('pluxel:builtins')
	})

	it('preloadPlugins auto-disables missing-dependency builtins and commits the rest', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Good' })
		class Good extends BasePlugin {}

		abstract class MissingBase extends BasePlugin {}

		@Plugin({ name: 'Bad' })
		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Bad, 0, MissingBase)

		const names = await loader.preloadPlugins([Good, Bad])
		expect(names.slice().sort()).toEqual(['Bad', 'Good'])

		expect(ctx.configService.isEnabledInConfig('Good')).toBe(true)
		expect(ctx.configService.isEnabledInConfig('Bad')).toBe(false)
		expect(core.registry.isRunning(Good)).toBe(true)
		expect(core.registry.isRunning(Bad)).toBe(false)
	})

	it('preloadPlugins does not re-enable disabled builtins on subsequent startups', async () => {
		const state = {
			enabled: new Set<string>(),
			extra: Object.create(null) as Record<string, unknown>,
		}

		@Plugin({ name: 'Good' })
		class Good extends BasePlugin {}

		abstract class MissingBase extends BasePlugin {}

		@Plugin({ name: 'Bad' })
		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Bad, 0, MissingBase)

		{
			const { core, ctx } = createHmrTestContext(state)
			const loader = new LoaderService(ctx)

			await loader.preloadPlugins([Good, Bad])
			expect(ctx.configService.isEnabledInConfig('Good')).toBe(true)
			expect(ctx.configService.isEnabledInConfig('Bad')).toBe(false)
			expect(core.registry.isRunning(Good)).toBe(true)
			expect(core.registry.isRunning(Bad)).toBe(false)

			// Simulate user disabling the healthy plugin as well.
			ctx.configService.disableInConfig('Good')
		}

		// New startup: should respect disabled bits and should not "seed enable" again.
		{
			const { core, ctx } = createHmrTestContext(state)
			const loader = new LoaderService(ctx)

			await loader.preloadPlugins([Good, Bad])
			expect(ctx.configService.isEnabledInConfig('Good')).toBe(false)
			expect(ctx.configService.isEnabledInConfig('Bad')).toBe(false)
			expect(core.registry.isRunning(Good)).toBe(false)
			expect(core.registry.isRunning(Bad)).toBe(false)

			const known = ctx.configService.getExtra(EXTRA_BUILTINS_KNOWN) as
				| BuiltinsKnownExtra
				| undefined
			expect(known?.Good).toBe(1)
			expect(known?.Bad).toBe(1)
		}
	})

	it('preloadPlugins strict mode throws on missing dependency', async () => {
		const { ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Good' })
		class Good extends BasePlugin {}

		abstract class MissingBase extends BasePlugin {}

		@Plugin({ name: 'Bad' })
		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Bad, 0, MissingBase)

		await expect(loader.preloadPlugins([Good, Bad], { strict: true })).rejects.toThrow(
			/builtin preload commit failed/i,
		)
		// rollback should revert enable bits introduced by this call
		expect(ctx.configService.isEnabledInConfig('Good')).toBe(false)
		expect(ctx.configService.isEnabledInConfig('Bad')).toBe(false)
	})

	it('preloadPlugins enables and commits builtins', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Builtin' })
		class Builtin extends BasePlugin {}

		const names = await loader.preloadPlugins([Builtin])
		expect(names).toEqual(['Builtin'])
		expect(ctx.configService.isEnabledInConfig('Builtin')).toBe(true)
		expect(loader.api.registry.getCtor('Builtin')).toBe(Builtin)
		expect(loader.api.registry.findModuleId('Builtin')).toBe('pluxel:builtins')
		expect(core.registry.isRunning(Builtin)).toBe(true)
	})

	it('preloaded builtin baseline survives later failed batch rollback', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Builtin' })
		class Builtin extends BasePlugin {}

		await loader.preloadPlugins([Builtin])
		expect(core.registry.isRunning(Builtin)).toBe(true)

		abstract class MissingBase extends BasePlugin {}

		@Plugin({ name: 'Bad' })
		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Bad, 0, MissingBase)

		ctx.configService.enableInConfig('Bad')
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Bad.ts', { Bad })
			const res = await core.registry.commit()
			expect(res.ok).toBe(false)
			batch.rollback()
			core.registry.resetDraft()
		}

		expect(core.registry.isRunning(Builtin)).toBe(true)
		expect(loader.api.registry.getCtor('Builtin')).toBe(Builtin)
	})

	it('dependency inspector tolerates abstract/base tokens', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		abstract class Abs extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Abs) {
				super()
			}
		}
		setParamToken(Consumer, 0, Abs)

		core.registry.register(Impl)
		core.registry.register(Consumer)
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)

		const deps = loader.api.deps.list(Consumer)
		expect(deps).toEqual([{ name: 'Abs', isRunning: true }])
	})

	it('batch rollback keeps loader state consistent when core commit fails', async () => {
		const { core, ctx } = createHmrTestContext()
		// Enable baseline provider; the later consumer will be enabled too.
		ctx.configService.enableInConfig('Impl1', 'Consumer')
		const loader = new LoaderService(ctx)

		abstract class Abs extends BasePlugin {}
		abstract class MissingBase extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl1' })
		class Impl1 extends Abs {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Consumer, 0, MissingBase)

		// Baseline: load module A providing Impl1 and commit successfully.
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('A.ts', { Impl1 })
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(core.registry.getInstance(Abs)).toBeInstanceOf(Impl1)

		// Hot update: load module B providing an enabled plugin with missing deps -> commit should fail.
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('B.ts', { Consumer })
			const res = await core.registry.commit()
			expect(res.ok).toBe(false)
			batch.rollback()
			core.registry.resetDraft()
		}

		// After rollback, loader should not claim Consumer is loaded.
		expect(loader.api.registry.getCtor('Consumer')).toBeUndefined()
		expect(loader.api.anchors.has('B.ts')).toBe(false)

		// Core should still be on the previous container: base resolves to Impl1 and remains running.
		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(core.registry.getInstance(Abs)).toBeInstanceOf(Impl1)
	})

	it('replaceModule normalizes ctor-param tokens by plugin id (builtin/HMR ctor identity mismatch)', async () => {
		const { core, ctx } = createHmrTestContext()
		const warns: unknown[] = []
		;(ctx as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger.warn = (
			...args: unknown[]
		) => warns.push(args)
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Dep' })
		class Dep extends BasePlugin {}

		// 模拟 HMR 插件模块里“拿到了另一个 ctor 引用”，但插件 id 相同。
		// 真实场景常见于：builtin 预载已注册/运行，而 HMR 模块因为不同入口/打包产物/热更新重复评估
		// 导致导入到一个“同 id 的 ctor”，如果不归一化就会 MissingDependency。
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
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		expect(core.registry.isRunning(Consumer)).toBe(true)
		expect(warns.length).toBe(1)
		expect((warns[0] as unknown[])[0]).toBe(
			'依赖注入 token 已归一化：检测到同 id 不同 ctor 引用（建议检查 bridge/导入路径）',
		)
		expect((warns[0] as unknown[])[1]).toMatchObject({
			moduleId: 'Consumer.ts',
			consumer: 'Consumer',
		})
	})

	it('batch exposes DI-cascade affected modules so HMR can restart dependents not re-executed by moduleGraph', async () => {
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
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
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

		// Simulate the HMR pipeline path where Vite did not select Consumer.ts as a target:
		// runtime still reports the DI-cascade affected module so HMR can re-sync it before commit.
		expect(new Set(batch.listAffectedModules())).toEqual(new Set(['Dep.ts', 'Consumer.ts']))
		await loader.syncRuntimeForModules(batch.listAffectedModules())

		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

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

	it('rolls back single-plugin replace loader state when core commit fails', async () => {
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
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
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

	it('non-batch replaceModule syncs affected dependents without redundantly syncing the replaced module', async () => {
		const { core, ctx } = createHmrTestContext()
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)
		let depSeq = 0
		let consumerSeq = 0
		let syncCalls = 0
		const originalSyncRuntimeForModule = loader.syncRuntimeForModule.bind(loader)
		loader.syncRuntimeForModule = async (moduleId: string) => {
			syncCalls++
			await originalSyncRuntimeForModule(moduleId)
		}

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

		await loader.replaceModule('Dep.ts', { Dep })
		await loader.replaceModule('Consumer.ts', { Consumer })
		let res = await core.registry.commit()
		expect(res.ok).toBe(true)
		expect(syncCalls).toBe(0)

		@Plugin({ name: 'Dep' })
		class DepNext extends BasePlugin {
			readonly seq = ++depSeq
		}

		await loader.replaceModule('Dep.ts', { DepNext })
		res = await core.registry.commit()
		expect(res.ok).toBe(true)
		expect(syncCalls).toBe(1)

		const nextConsumer = core.registry.getInstance(
			loader.api.registry.getCtor('Consumer') ?? Consumer,
		)
		expect(nextConsumer?.seq).toBe(2)
		expect(nextConsumer?.dep.seq).toBe(2)
	})

	it('registry view exposes module ids and loaded names', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Alpha' })
		class Alpha extends BasePlugin {}

		@Plugin({ name: 'Beta' })
		class Beta extends BasePlugin {}

		const batch = loader.beginBatch()
		await batch.replaceModule('B.ts', { Beta })
		await batch.replaceModule('A.ts', { Alpha })
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		expect(loader.api.registry.findModuleId('Alpha')).toBe('A.ts')
		expect(loader.api.registry.findModuleIdByName('Beta')).toBe('B.ts')
		expect(loader.api.registry.listLoadedNames()).toEqual(['Alpha', 'Beta'])
	})

	it('anchors remove expects clean ids', async () => {
		const { ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Anchor' })
		class Anchor extends BasePlugin {}

		const batch = loader.beginBatch()
		await batch.replaceModule('/abs/Plugin.ts', { Anchor })

		expect(loader.api.anchors.has('/abs/Plugin.ts')).toBe(true)
		loader.api.anchors.remove('/abs/Plugin.ts')
		expect(loader.api.anchors.has('/abs/Plugin.ts')).toBe(false)
	})
})
