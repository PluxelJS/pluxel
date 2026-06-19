import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import type { ForkablePluginConstructor } from '@pluxel/core'
import { LoaderService } from '../../../runtime-dynamic/src/services'
import {
	EXTRA_BUILTINS_KNOWN,
	EXTRA_FORKS,
	type BuiltinsKnownExtra,
	type ForksExtra,
} from '../../../runtime-dynamic/src/loader/selection'
import { createHmrTestContext } from '../support/hmr-context'

function defineParamTypes(ctor: unknown, paramTypes: unknown[]) {
	;(
		Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void }
	).defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

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

	it('cleans up failed fork registrations from commitFailed events', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		class Worker extends ForkablePlugin {
			protected override init() {
				throw new Error('fork boom')
			}
		}
		Plugin({ name: 'Worker' })(Worker)

		ctx.configService.setExtra(EXTRA_FORKS, { Worker: ['f1'] })
		ctx.configService.enableInConfig('Worker#f1')

		const batch = loader.beginBatch()
		await batch.replaceModule('Worker.ts', { Worker })
		const Fork = core.registry.fork(Worker as unknown as ForkablePluginConstructor, 'f1')
		expect(core.registry.isRegistered(Fork)).toBe(true)

		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		expect(core.registry.lastCommit?.failed).toEqual(['Worker#f1'])
		expect(core.registry.isRegistered(Fork)).toBe(false)
		batch.commit()
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
		let moduleItemsSeenDuringStartupCommit: Function[] = []

		@Plugin({ name: 'Builtin' })
		class Builtin extends BasePlugin {}

		ctx.on('afterCommit', (summary) => {
			if ((summary as { reason?: string }).reason !== 'startup') return
			moduleItemsSeenDuringStartupCommit = core.registry
				.listRuntimeModuleItems('pluxel:builtins')
				.map((item) => item.ctor)
		})

		const names = await loader.preloadPlugins([Builtin])
		expect(names).toEqual(['Builtin'])
		expect(ctx.configService.isEnabledInConfig('Builtin')).toBe(true)
		expect(loader.api.registry.getCtor('Builtin')).toBe(Builtin)
		expect(loader.api.registry.findModuleId('Builtin')).toBe('pluxel:builtins')
		expect(core.registry.isRunning(Builtin)).toBe(true)
		expect(moduleItemsSeenDuringStartupCommit).toEqual([Builtin])
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
		expect(core.registry.getRuntimeModuleId(Alpha)).toBe('A.ts')
		expect(core.registry.getRuntimeModuleId('Beta')).toBe('B.ts')
		expect(core.registry.listRuntimeModuleItems('A.ts')).toEqual([
			{ ctor: Alpha, exportKey: 'Alpha' },
		])
	})

	it('does not publish rolled back loader declarations to core ownership', async () => {
		const { core, ctx } = createHmrTestContext()
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Committed' })
		class Committed extends BasePlugin {}

		@Plugin({ name: 'RolledBack' })
		class RolledBack extends BasePlugin {}

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
