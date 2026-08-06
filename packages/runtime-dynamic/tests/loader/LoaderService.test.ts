import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, setParamToken } from '@pluxel/runtime/test'
import type { ForkablePluginConstructor } from '@pluxel/core'
import { createHmrTestContext } from '../support/hmr-context'
import { enablePlugins, isEnabled } from '../support/runtime-state'

function defineParamTypes(ctor: unknown, paramTypes: unknown[]) {
	;(
		Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void }
	).defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

const fixedOwner = 'pluxel:fixed:/workspace/pluxel.dynamic.ts'

describe('LoaderService', () => {
	it('registers disabled fixed plugins in the catalog without changing enablement', async () => {
		const { core, ctx } = createHmrTestContext()
		class Fixed extends BasePlugin {}
		Plugin({ name: 'Fixed' })(Fixed)

		await expect(
			ctx.loader.registerFixedPlugins([Fixed], { moduleId: fixedOwner }),
		).resolves.toEqual(['Fixed'])

		expect(isEnabled(ctx, 'Fixed')).toBe(false)
		expect(ctx.loader.api.registry.getCtor('Fixed')).toBe(Fixed)
		expect(ctx.loader.api.registry.findModuleId('Fixed')).toBe(fixedOwner)
		expect(core.registry.isRunning(Fixed)).toBe(false)
	})

	it('starts enabled fixed providers before consumers through the normal graph commit', async () => {
		const { core, ctx } = createHmrTestContext()
		const started: string[] = []

		class Provider extends BasePlugin {
			override init() {
				started.push('provider')
			}
		}
		Plugin({ name: 'Provider' })(Provider)

		class Consumer extends BasePlugin {
			constructor(readonly provider: Provider) {
				super()
			}
			override init() {
				started.push('consumer')
			}
		}
		defineParamTypes(Consumer, [Provider])
		Plugin({ name: 'Consumer' })(Consumer)
		setParamToken(Consumer, 0, Provider)

		enablePlugins(ctx, 'Provider', 'Consumer')
		await ctx.loader.registerFixedPlugins([Consumer, Provider], { moduleId: fixedOwner })

		expect(started).toEqual(['provider', 'consumer'])
		expect(core.registry.getInstance(Consumer)?.provider).toBeInstanceOf(Provider)
	})

	it('rejects distinct fixed constructors with the same plugin id', async () => {
		const { ctx } = createHmrTestContext()
		class First extends BasePlugin {}
		class Second extends BasePlugin {}
		Plugin({ name: 'Duplicate' })(First)
		Plugin({ name: 'Duplicate' })(Second)

		await expect(
			ctx.loader.registerFixedPlugins([First, Second], { moduleId: fixedOwner }),
		).rejects.toThrow(/fixed catalog contains duplicate plugin id "Duplicate"/i)
		expect(ctx.loader.api.registry.getCtor('Duplicate')).toBeUndefined()
	})

	it('rejects the same constructor when a mutable entry re-exports a fixed plugin', async () => {
		const { ctx } = createHmrTestContext()
		class Fixed extends BasePlugin {}
		Plugin({ name: 'Fixed' })(Fixed)

		await ctx.loader.registerFixedPlugins([Fixed], { moduleId: fixedOwner })

		await expect(
			ctx.loader.replaceModule('/workspace/entries/reexport.ts', { Fixed }),
		).rejects.toThrow(/插件名冲突.*Fixed/)
		expect(ctx.loader.api.registry.getCtor('Fixed')).toBe(Fixed)
		expect(ctx.loader.api.registry.findModuleId('Fixed')).toBe(fixedOwner)
	})

	it('fails fixed catalog verification without auto-disabling persisted state', async () => {
		const { ctx } = createHmrTestContext()
		abstract class Missing extends BasePlugin {}
		class Consumer extends BasePlugin {
			constructor(_missing: Missing) {
				super()
			}
		}
		defineParamTypes(Consumer, [Missing])
		Plugin({ name: 'Consumer' })(Consumer)
		setParamToken(Consumer, 0, Missing)
		enablePlugins(ctx, 'Consumer')

		await expect(
			ctx.loader.registerFixedPlugins([Consumer], { moduleId: fixedOwner }),
		).rejects.toThrow(/fixed catalog commit failed/i)
		expect(isEnabled(ctx, 'Consumer')).toBe(true)
		expect(ctx.loader.api.registry.getCtor('Consumer')).toBeUndefined()
	})

	it('derives enabled forks exclusively from RuntimeState', async () => {
		const { core, ctx } = createHmrTestContext()
		class FixedForkable extends ForkablePlugin {}
		Plugin({ name: 'FixedForkable' })(FixedForkable)
		ctx.runtimeState.update((draft) => {
			draft.forks = { FixedForkable: ['worker'] }
		})
		enablePlugins(ctx, 'FixedForkable#worker')

		await ctx.loader.registerFixedPlugins([FixedForkable], { moduleId: fixedOwner })
		const Fork = core.registry.fork(FixedForkable as unknown as ForkablePluginConstructor, 'worker')
		expect(core.registry.isRunning(FixedForkable)).toBe(false)
		expect(core.registry.isRunning(Fork)).toBe(true)
		expect(ctx.loader.api.registry.findModuleId('FixedForkable#worker')).toBe(fixedOwner)
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
