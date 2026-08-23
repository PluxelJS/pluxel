import { describe, expect, it } from 'vitest'
import {
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { requireRuntimePluginGraphCoordinator, runtimeStatePatch } from '@pluxel/runtime/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { requireLoaderService } from '../../src/context-plan'
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
		const { ctx } = createHmrTestContext()

		@Plugin()
		class Fixed extends BasePlugin {}
		lowerTestPlugin(Fixed)

		const address = pluginNodeAddressOf(Fixed)
		await expect(
			requireLoaderService(ctx).registerFixedPlugins([Fixed], { moduleId: fixedOwner }),
		).resolves.toEqual([address])

		expect(isEnabled(ctx, address)).toBe(false)
		expect(requireLoaderService(ctx).api.registry.getCtor(address)).toBe(Fixed)
		expect(requireLoaderService(ctx).api.registry.findModuleId(address)).toBe(fixedOwner)
		expect(requireLoaderService(ctx).api.anchors.has(fixedOwner)).toBe(false)
		expect(requirePluginService(ctx).isRunning(address)).toBe(false)
	})

	it('starts enabled fixed dependencies from lowered constructor facts', async () => {
		const { ctx } = createHmrTestContext()
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

		await requireLoaderService(ctx).registerFixedPlugins([Consumer, Provider], {
			moduleId: fixedOwner,
		})
		await enablePlugins(ctx, Provider, Consumer)

		expect(started).toEqual(['provider', 'consumer'])
		expect(
			(requirePluginService(ctx).getInstance(pluginNodeAddressOf(Consumer)) as Consumer | undefined)
				?.provider,
		).toBeInstanceOf(Provider)
	})

	it('allows equal display names at distinct definition addresses', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Shared label' })
		class FirstAddress extends BasePlugin {}
		lowerTestPlugin(FirstAddress)

		@Plugin({ displayName: 'Shared label' })
		class SecondAddress extends BasePlugin {}
		lowerTestPlugin(SecondAddress)

		await requireLoaderService(ctx).replaceModule('first.ts', { FirstAddress })
		await requireLoaderService(ctx).replaceModule('second.ts', { SecondAddress })

		const entries = requireLoaderService(ctx).api.registry.listRegistered()
		expect(entries).toHaveLength(2)
		expect(entries.map((entry) => entry.displayName)).toEqual(['Shared label', 'Shared label'])
		expect(pluginNodeAddressEqual(entries[0]!.address, entries[1]!.address)).toBe(false)
	})

	it('rejects a second module claiming an existing definition slot', async () => {
		const { ctx } = createHmrTestContext()

		const Original = class Original extends BasePlugin {}
		Plugin()(Original)
		lowerTestPlugin(Original, { path: 'tests/runtime-dynamic/shared.ts' })

		const Replacement = class Replacement extends BasePlugin {}
		Plugin({ displayName: 'Replacement generation' })(Replacement)
		lowerTestPlugin(Replacement, {
			path: 'tests/runtime-dynamic/shared.ts',
			exportName: 'Original',
		})
		const address = pluginNodeAddressOf(Original)
		await requireLoaderService(ctx).replaceModule('first.ts', { Original })

		await expect(
			requireLoaderService(ctx).replaceModule('second.ts', { Original: Replacement }),
		).rejects.toThrow(/already owned by first\.ts/i)
		expect(requireLoaderService(ctx).api.registry.getCtor(address)).toBe(Original)
		expect(requireLoaderService(ctx).api.registry.findModuleId(address)).toBe('first.ts')
	})

	it('rolls back the complete source transaction on root export mismatch', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Root export' })
		class RootExport extends BasePlugin {}
		lowerTestPlugin(RootExport)

		const address = pluginNodeAddressOf(RootExport)
		await expect(
			requireLoaderService(ctx).replaceModule('bad-export.ts', { Alias: RootExport }),
		).rejects.toThrow(/must be loaded from root export "RootExport"/i)
		expect(requireLoaderService(ctx).api.registry.getCtor(address)).toBeUndefined()
		expect(requireLoaderService(ctx).api.anchors.has('bad-export.ts')).toBe(false)
	})

	it('rolls back a source with a marked constructor missing lowering facts', async () => {
		const { ctx } = createHmrTestContext()
		const Unlowered = class extends BasePlugin {}
		Plugin()(Unlowered)

		await expect(
			requireLoaderService(ctx).replaceModule('unlowered.ts', { Unlowered }),
		).rejects.toThrow(/Plugin declaration was not lowered/i)
		expect(requireLoaderService(ctx).api.registry.listRegistered()).toEqual([])
		expect(requireLoaderService(ctx).api.anchors.has('unlowered.ts')).toBe(false)
	})

	it('derives enabled fork nodes exclusively from RuntimeState v3', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Forkable', forkable: true })
		class FixedForkable extends BasePlugin {}
		lowerTestPlugin(FixedForkable)

		const base = pluginNodeAddressOf(FixedForkable)
		const worker = forkAddress(FixedForkable, 'worker')
		await requireLoaderService(ctx).registerFixedPlugins([FixedForkable], { moduleId: fixedOwner })
		await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: base.definition, forkId: 'worker' },
				{ type: 'set-enabled', node: worker, enabled: true },
			),
		)
		expect(requirePluginService(ctx).isRunning(base)).toBe(false)
		expect(requireLoaderService(ctx).api.runtime.isRunning(worker)).toBe(true)
		expect(requireLoaderService(ctx).api.registry.findModuleId(worker)).toBe(fixedOwner)
	})

	it('keeps module provenance in the route catalog and out of Core identity', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Catalog entry' })
		class CatalogEntry extends BasePlugin {}
		lowerTestPlugin(CatalogEntry)

		await requireLoaderService(ctx).replaceModule('catalog.ts', { CatalogEntry })
		const address = pluginNodeAddressOf(CatalogEntry)

		expect(requireLoaderService(ctx).api.registry.findModuleId(address)).toBe('catalog.ts')
		expect(requireLoaderService(ctx).api.registry.getExportKey(address)).toBe('CatalogEntry')
		expect(
			requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot().entries[0]?.provenance,
		).toEqual({
			moduleId: 'catalog.ts',
		})
	})

	it('caches the anchor projection for one committed catalog snapshot', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class FirstAnchor extends BasePlugin {}
		lowerTestPlugin(FirstAnchor)

		@Plugin()
		class SecondAnchor extends BasePlugin {}
		lowerTestPlugin(SecondAnchor)

		await requireLoaderService(ctx).replaceModule('first-anchor.ts', { FirstAnchor })
		const first = requireLoaderService(ctx).api.anchors.snapshot()
		expect(requireLoaderService(ctx).api.anchors.snapshot()).toBe(first)
		expect(first).toEqual(new Set(['first-anchor.ts']))

		await requireLoaderService(ctx).replaceModule('second-anchor.ts', { SecondAnchor })
		const second = requireLoaderService(ctx).api.anchors.snapshot()
		expect(second).not.toBe(first)
		expect(second).toEqual(new Set(['first-anchor.ts', 'second-anchor.ts']))
	})

	it('does not publish rolled-back loader declarations to the common catalog', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Rolled back' })
		class RolledBack extends BasePlugin {}
		lowerTestPlugin(RolledBack)

		const batch = requireLoaderService(ctx).beginBatch()
		await batch.replaceModule('rolled-back.ts', { RolledBack })
		batch.rollback()

		expect(
			requireLoaderService(ctx).api.registry.getCtor(pluginNodeAddressOf(RolledBack)),
		).toBeUndefined()
		expect(requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot().entries).toEqual([])
	})

	it('rejects a stale route draft through the coordinator catalog revision', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class First extends BasePlugin {}
		lowerTestPlugin(First)

		@Plugin()
		class Stale extends BasePlugin {}
		lowerTestPlugin(Stale)

		const first = requireLoaderService(ctx).beginBatch()
		const stale = requireLoaderService(ctx).beginBatch()
		await first.replaceModule('first.ts', { First })
		await stale.replaceModule('stale.ts', { Stale })
		await first.commit({
			statePatch: runtimeStatePatch({
				type: 'set-enabled',
				node: pluginNodeAddressOf(First),
				enabled: true,
			}),
		})

		await expect(stale.commit()).rejects.toThrow(/catalog revision must advance/)
		expect(requireLoaderService(ctx).api.registry.getCtor(pluginNodeAddressOf(First))).toBe(First)
		expect(
			requireLoaderService(ctx).api.registry.getCtor(pluginNodeAddressOf(Stale)),
		).toBeUndefined()
		expect(requirePluginService(ctx).isRunning(pluginNodeAddressOf(First))).toBe(true)
		expect(requirePluginService(ctx).isRunning(pluginNodeAddressOf(Stale))).toBe(false)
		expect(
			requireRuntimePluginGraphCoordinator(ctx)
				.catalogSnapshot()
				.entries.map((entry) => entry.candidate.implementation),
		).toEqual([First])
	})
})
