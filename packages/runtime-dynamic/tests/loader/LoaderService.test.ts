import { describe, expect, it } from 'vitest'
import {
	clonePluginDefinition,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/runtime/test'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestPlugin } from '../support/lowered-plugin'
import { enablePlugins, isEnabled } from '../support/runtime-state'

const fixedOwner = 'pluxel:fixed:/workspace/pluxel.dynamic.ts'

function forkAddress(plugin: PluginConstructor, forkId: string): PluginNodeAddress {
	return {
		definition: pluginNodeAddressOf(plugin).definition,
		variant: 'fork',
		forkId,
	}
}

describe('LoaderService', () => {
	it('registers disabled fixed plugins by address without changing enablement', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin()
		class Fixed extends BasePlugin {}
		lowerTestPlugin(Fixed)

		const address = pluginNodeAddressOf(Fixed)
		await expect(
			ctx.loader.registerFixedPlugins([Fixed], { moduleId: fixedOwner }),
		).resolves.toEqual([address])

		expect(isEnabled(ctx, address)).toBe(false)
		expect(ctx.loader.api.registry.getCtor(address)).toBe(Fixed)
		expect(ctx.loader.api.registry.findModuleId(address)).toBe(fixedOwner)
		expect(core.registry.isRunning(Fixed)).toBe(false)
	})

	it('starts enabled fixed dependencies from lowered constructor facts', async () => {
		const { core, ctx } = createHmrTestContext()
		const started: string[] = []

		@Plugin()
		class Provider extends BasePlugin {
			override init() {
				started.push('provider')
			}
		}
		lowerTestPlugin(Provider)

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly provider: Provider) {
				super()
			}
			override init() {
				started.push('consumer')
			}
		}
		lowerTestPlugin(Consumer, { requires: [Provider] })

		enablePlugins(ctx, Provider, Consumer)
		await ctx.loader.registerFixedPlugins([Consumer, Provider], { moduleId: fixedOwner })

		expect(started).toEqual(['provider', 'consumer'])
		expect(core.registry.getInstance(Consumer)?.provider).toBeInstanceOf(Provider)
	})

	it('allows equal display names at distinct definition addresses', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Shared label' })
		class FirstAddress extends BasePlugin {}
		lowerTestPlugin(FirstAddress)

		@Plugin({ displayName: 'Shared label' })
		class SecondAddress extends BasePlugin {}
		lowerTestPlugin(SecondAddress)

		await ctx.loader.replaceModule('first.ts', { FirstAddress })
		await ctx.loader.replaceModule('second.ts', { SecondAddress })

		const entries = ctx.loader.api.registry.listRegistered()
		expect(entries).toHaveLength(2)
		expect(entries.map((entry) => entry.displayName)).toEqual(['Shared label', 'Shared label'])
		expect(pluginNodeAddressEqual(entries[0]!.address, entries[1]!.address)).toBe(false)
	})

	it('rejects a second module claiming an existing definition slot', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class Original extends BasePlugin {}
		lowerTestPlugin(Original)

		@Plugin({ displayName: 'Replacement generation' })
		class Replacement extends BasePlugin {}
		lowerTestPlugin(Replacement)

		clonePluginDefinition(Original, Replacement)
		const address = pluginNodeAddressOf(Original)
		await ctx.loader.replaceModule('first.ts', { Original })

		await expect(ctx.loader.replaceModule('second.ts', { Original: Replacement })).rejects.toThrow(
			/already owned by first\.ts/i,
		)
		expect(ctx.loader.api.registry.getCtor(address)).toBe(Original)
		expect(ctx.loader.api.registry.findModuleId(address)).toBe('first.ts')
	})

	it('rolls back the complete source transaction on root export mismatch', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Root export' })
		class RootExport extends BasePlugin {}
		lowerTestPlugin(RootExport)

		const address = pluginNodeAddressOf(RootExport)
		await expect(ctx.loader.replaceModule('bad-export.ts', { Alias: RootExport })).rejects.toThrow(
			/must be loaded from root export "RootExport"/i,
		)
		expect(ctx.loader.api.registry.getCtor(address)).toBeUndefined()
		expect(ctx.loader.api.anchors.has('bad-export.ts')).toBe(false)
	})

	it('rolls back a source with a marked constructor missing lowering facts', async () => {
		const { ctx } = createHmrTestContext()
		const Unlowered = class extends BasePlugin {}
		Plugin()(Unlowered)

		await expect(ctx.loader.replaceModule('unlowered.ts', { Unlowered })).rejects.toThrow(
			/Plugin definition was not lowered/i,
		)
		expect(ctx.loader.api.registry.listRegistered()).toEqual([])
		expect(ctx.loader.api.anchors.has('unlowered.ts')).toBe(false)
	})

	it('derives enabled fork nodes exclusively from RuntimeState v3', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Forkable' })
		class FixedForkable extends ForkablePlugin {}
		lowerTestPlugin(FixedForkable)

		const base = pluginNodeAddressOf(FixedForkable)
		const worker = forkAddress(FixedForkable, 'worker')
		ctx.runtimeState.update((draft) => {
			draft.forks = [{ definition: base.definition, forkIds: ['worker'] }]
		})
		enablePlugins(ctx, worker)

		await ctx.loader.registerFixedPlugins([FixedForkable], { moduleId: fixedOwner })
		expect(core.registry.isRunning(FixedForkable)).toBe(false)
		expect(ctx.loader.api.runtime.isRunning(worker)).toBe(true)
		expect(ctx.loader.api.registry.findModuleId(worker)).toBe(fixedOwner)
	})

	it('publishes address-first module ownership and no export-name identity map', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Catalog entry' })
		class CatalogEntry extends BasePlugin {}
		lowerTestPlugin(CatalogEntry)

		await ctx.loader.replaceModule('catalog.ts', { CatalogEntry })
		const address = pluginNodeAddressOf(CatalogEntry)

		expect(ctx.loader.api.registry.findModuleId(address)).toBe('catalog.ts')
		expect(ctx.loader.api.registry.getExportKey(address)).toBe('CatalogEntry')
		expect(core.registry.getRuntimeModuleId(core.registry.internNodeAddress(address))).toBe(
			'catalog.ts',
		)
		expect(core.registry.listRuntimeModuleItems('catalog.ts')).toEqual([{ ctor: CatalogEntry }])
	})

	it('does not publish rolled-back loader declarations to Core ownership', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Rolled back' })
		class RolledBack extends BasePlugin {}
		lowerTestPlugin(RolledBack)

		const batch = ctx.loader.beginBatch()
		await batch.replaceModule('rolled-back.ts', { RolledBack })
		batch.rollback()
		core.registry.resetDraft()

		expect(ctx.loader.api.registry.getCtor(pluginNodeAddressOf(RolledBack))).toBeUndefined()
		expect(core.registry.getRuntimeModuleId(pluginNodeAddressOf(RolledBack))).toBeUndefined()
		expect(core.registry.listRuntimeModuleItems('rolled-back.ts')).toEqual([])
	})
})
