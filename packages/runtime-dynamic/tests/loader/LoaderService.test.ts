import { describe, expect, it } from 'vitest'
import {
	BasePlugin,
	ForkablePlugin,
	Plugin,
	assertPluginLifecycleIssue,
	setParamToken,
} from '@pluxel/runtime/test'
import type { ForkablePluginConstructor } from '@pluxel/core'
import { createHmrTestContext } from '../support/hmr-context'
import { disablePlugins, enablePlugins, isEnabled } from '../support/runtime-state'

function defineParamTypes(ctor: unknown, paramTypes: unknown[]) {
	;(
		Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void }
	).defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

describe('LoaderService', () => {
	it('preloadPlugins supports forkable builtins (including enabled forks)', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Forky extends ForkablePlugin {}
		Plugin({ name: 'Forky' })(Forky)

		await loader.preloadPlugins([
			{
				plugin: Forky,
				enable: false,
				forks: ['a', { id: 'b', enable: true }, { id: 'c', enable: false }],
			},
		])

		expect(isEnabled(ctx, 'Forky')).toBe(false)
		expect(isEnabled(ctx, 'Forky#a')).toBe(true)
		expect(isEnabled(ctx, 'Forky#b')).toBe(true)
		expect(isEnabled(ctx, 'Forky#c')).toBe(false)

		const catalog = ctx.runtimeState.snapshot().forks
		expect(catalog?.Forky?.slice().sort()).toEqual(['a', 'b', 'c'])

		const ForkA = core.registry.fork(Forky as unknown as ForkablePluginConstructor, 'a')
		const ForkB = core.registry.fork(Forky as unknown as ForkablePluginConstructor, 'b')
		expect(core.registry.isRunning(Forky)).toBe(false)
		expect(core.registry.isRunning(ForkA)).toBe(true)
		expect(core.registry.isRunning(ForkB)).toBe(true)

		// Fork source should resolve to the base plugin module id.
		expect(loader.api.registry.findModuleId('Forky#a')).toBe('pluxel:builtins')
	})

	it('cleans up failed fork registrations after committed lifecycle reports', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Worker extends ForkablePlugin {
			protected override init() {
				throw new Error('fork boom')
			}
		}
		Plugin({ name: 'Worker' })(Worker)

		ctx.runtimeState.update((draft) => {
			draft.forks = { Worker: ['f1'] }
		})
		enablePlugins(ctx, 'Worker#f1')

		const batch = loader.beginBatch()
		await batch.replaceModule('Worker.ts', { Worker })
		const Fork = core.registry.fork(Worker as unknown as ForkablePluginConstructor, 'f1')
		expect(core.registry.isRegistered(Fork)).toBe(true)

		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		assertPluginLifecycleIssue(core.registry.lastCommit!, 'Worker#f1', { kind: 'start-failed' })
		expect(core.registry.isRegistered(Fork)).toBe(false)
		batch.commit()
	})

	it('preloadPlugins auto-disables missing-dependency builtins and commits the rest', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Good extends BasePlugin {}
		Plugin({ name: 'Good' })(Good)

		abstract class MissingBase extends BasePlugin {}

		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		defineParamTypes(Bad, [MissingBase])
		Plugin({ name: 'Bad' })(Bad)
		setParamToken(Bad, 0, MissingBase)

		const names = await loader.preloadPlugins([Good, Bad])
		expect(names.slice().sort()).toEqual(['Bad', 'Good'])

		expect(isEnabled(ctx, 'Good')).toBe(true)
		expect(isEnabled(ctx, 'Bad')).toBe(false)
		expect(core.registry.isRunning(Good)).toBe(true)
		expect(core.registry.isRunning(Bad)).toBe(false)
	})

	it('preloadPlugins does not re-enable disabled builtins on subsequent startups', async () => {
		const state = {
			enabled: new Set<string>(),
			extra: Object.create(null) as Record<string, unknown>,
		}

		class Good extends BasePlugin {}
		Plugin({ name: 'Good' })(Good)

		abstract class MissingBase extends BasePlugin {}

		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		defineParamTypes(Bad, [MissingBase])
		Plugin({ name: 'Bad' })(Bad)
		setParamToken(Bad, 0, MissingBase)

		{
			const { core, ctx } = createHmrTestContext(state)
			const loader = ctx.loader

			await loader.preloadPlugins([Good, Bad])
			expect(isEnabled(ctx, 'Good')).toBe(true)
			expect(isEnabled(ctx, 'Bad')).toBe(false)
			expect(core.registry.isRunning(Good)).toBe(true)
			expect(core.registry.isRunning(Bad)).toBe(false)

			// Simulate user disabling the healthy plugin as well.
			disablePlugins(ctx, 'Good')
		}

		// New startup: should respect disabled bits and should not "seed enable" again.
		{
			const { core, ctx } = createHmrTestContext(state)
			const loader = ctx.loader

			await loader.preloadPlugins([Good, Bad])
			expect(isEnabled(ctx, 'Good')).toBe(false)
			expect(isEnabled(ctx, 'Bad')).toBe(false)
			expect(core.registry.isRunning(Good)).toBe(false)
			expect(core.registry.isRunning(Bad)).toBe(false)

			const known = ctx.runtimeState.snapshot().builtinsKnown
			expect(known?.Good).toBe(1)
			expect(known?.Bad).toBe(1)
		}
	})

	it('preloadPlugins strict mode throws on missing dependency', async () => {
		const { ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Good extends BasePlugin {}
		Plugin({ name: 'Good' })(Good)

		abstract class MissingBase extends BasePlugin {}

		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		defineParamTypes(Bad, [MissingBase])
		Plugin({ name: 'Bad' })(Bad)
		setParamToken(Bad, 0, MissingBase)

		await expect(loader.preloadPlugins([Good, Bad], { strict: true })).rejects.toThrow(
			/builtin preload commit failed/i,
		)
		// rollback should revert enable bits introduced by this call
		expect(isEnabled(ctx, 'Good')).toBe(false)
		expect(isEnabled(ctx, 'Bad')).toBe(false)
	})

	it('preloadPlugins enables and commits builtins', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader
		let moduleItemsSeenDuringStartupCommit: Function[] = []

		class Builtin extends BasePlugin {}
		Plugin({ name: 'Builtin' })(Builtin)

		ctx.internalEvent.runtimeCommitted.on((summary) => {
			if ((summary as { runtimeUpdate?: { reason?: string } }).runtimeUpdate?.reason !== 'startup')
				return
			moduleItemsSeenDuringStartupCommit = core.registry
				.listRuntimeModuleItems('pluxel:builtins')
				.map((item) => item.ctor)
		})

		const names = await loader.preloadPlugins([Builtin])
		expect(names).toEqual(['Builtin'])
		expect(isEnabled(ctx, 'Builtin')).toBe(true)
		expect(loader.api.registry.getCtor('Builtin')).toBe(Builtin)
		expect(loader.api.registry.findModuleId('Builtin')).toBe('pluxel:builtins')
		expect(core.registry.isRunning(Builtin)).toBe(true)
		expect(moduleItemsSeenDuringStartupCommit).toEqual([Builtin])
	})

	it('preloaded builtin baseline survives later failed batch rollback', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Builtin extends BasePlugin {}
		Plugin({ name: 'Builtin' })(Builtin)

		await loader.preloadPlugins([Builtin])
		expect(core.registry.isRunning(Builtin)).toBe(true)

		abstract class MissingBase extends BasePlugin {}

		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		defineParamTypes(Bad, [MissingBase])
		Plugin({ name: 'Bad' })(Bad)
		setParamToken(Bad, 0, MissingBase)

		enablePlugins(ctx, 'Bad')
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
		const loader = ctx.loader

		abstract class Abs extends BasePlugin {}

		class Impl extends Abs {}
		Plugin(Abs, { name: 'Impl' })(Impl)

		class Consumer extends BasePlugin {
			constructor(_dep: Abs) {
				super()
			}
		}
		defineParamTypes(Consumer, [Abs])
		Plugin({ name: 'Consumer' })(Consumer)
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
		enablePlugins(ctx, 'Impl1', 'Consumer')
		const loader = ctx.loader

		abstract class Abs extends BasePlugin {}
		abstract class MissingBase extends BasePlugin {}

		class Impl1 extends Abs {}
		Plugin(Abs, { name: 'Impl1' })(Impl1)

		class Consumer extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		defineParamTypes(Consumer, [MissingBase])
		Plugin({ name: 'Consumer' })(Consumer)
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

	it('registry view exposes module ids and loaded names', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Alpha extends BasePlugin {}
		Plugin({ name: 'Alpha' })(Alpha)

		class Beta extends BasePlugin {}
		Plugin({ name: 'Beta' })(Beta)

		const batch = loader.beginBatch()
		await batch.replaceModule('B.ts', { Beta })
		await batch.replaceModule('A.ts', { Alpha })
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		expect(loader.api.registry.findModuleId('Alpha')).toBe('A.ts')
		expect(loader.api.registry.findModuleIdByName('Beta')).toBe('B.ts')
		expect(loader.api.registry.listLoadedNames()).toEqual(['Alpha', 'Beta'])
		expect(core.registry.getRuntimeModuleId(Alpha)).toBe('A.ts')
		expect(core.registry.getRuntimeModuleId('Beta')).toBe('B.ts')
		expect(core.registry.listRuntimeModuleItems('A.ts')).toEqual([
			{ ctor: Alpha, exportKey: 'Alpha' },
		])
	})

	it('does not publish rolled back loader declarations to core ownership', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Committed extends BasePlugin {}
		Plugin({ name: 'Committed' })(Committed)

		class RolledBack extends BasePlugin {}
		Plugin({ name: 'RolledBack' })(RolledBack)

		const committed = loader.beginBatch()
		await committed.replaceModule('Committed.ts', { Committed })
		const committedRes = await core.registry.commit()
		expect(committedRes.ok).toBe(true)
		committed.commit()

		const rolledBack = loader.beginBatch()
		await rolledBack.replaceModule('RolledBack.ts', { RolledBack })
		rolledBack.rollback()
		core.registry.resetDraft()

		expect(core.registry.getRuntimeModuleId(Committed)).toBe('Committed.ts')
		expect(core.registry.getRuntimeModuleId(RolledBack)).toBeUndefined()
		expect(core.registry.listRuntimeModuleItems('RolledBack.ts')).toEqual([])
	})

	it('anchors remove expects clean ids', async () => {
		const { ctx } = createHmrTestContext()
		const loader = ctx.loader

		class Anchor extends BasePlugin {}
		Plugin({ name: 'Anchor' })(Anchor)

		const batch = loader.beginBatch()
		await batch.replaceModule('/abs/Plugin.ts', { Anchor })

		expect(loader.api.anchors.has('/abs/Plugin.ts')).toBe(true)
		loader.api.anchors.remove('/abs/Plugin.ts')
		expect(loader.api.anchors.has('/abs/Plugin.ts')).toBe(false)
	})
})
