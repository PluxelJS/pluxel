import { describe, expect, it } from 'vitest'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { requireRuntimePluginGraphCoordinator, runtimeStatePatch } from '@pluxel/runtime/internal'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'
import { enablePlugins, enablePluginsPatch } from '../support/runtime-state'

describe('LoaderService HMR lifecycle', () => {
	it('keeps the definition/node slot and restarts required dependents once', async () => {
		const { ctx } = createHmrTestContext()
		let depStarts = 0
		let consumerStarts = 0

		@Plugin({ displayName: 'Dependency' })
		class Dep extends BasePlugin {
			readonly generation = 1
			override init() {
				depStarts++
			}
		}
		lowerTestPlugin(Dep)

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly dep: Dep) {
				super()
			}
			override init() {
				consumerStarts++
			}
		}
		lowerTestPlugin(Consumer, { requires: [Dep] })

		await ctx.loader.replaceModule('Dep.ts', { Dep })
		await ctx.loader.replaceModule('Consumer.ts', { Consumer })
		await enablePlugins(ctx, Dep, Consumer)

		const originalAddress = pluginNodeAddressOf(Dep)
		const pluginService = requirePluginService(ctx)
		const originalSlot = pluginService.resolvePluginNode(originalAddress)
		const firstConsumer = pluginService.getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(firstConsumer?.dep.generation).toBe(1)
		expect([depStarts, consumerStarts]).toEqual([1, 1])

		const DepNext = class DepNext extends BasePlugin {
			readonly generation = 2
			override init() {
				depStarts++
			}
		}
		Plugin({ displayName: 'Dependency' })(DepNext)
		lowerTestPlugin(DepNext, {
			exportName: 'Dep',
			path: 'tests/runtime-dynamic/Dep.ts',
		})

		const result = await ctx.loader.replaceModule('Dep.ts', { Dep: DepNext })
		const nextAddress = pluginNodeAddressOf(DepNext)
		const nextConsumer = pluginService.getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined

		expect(result.affectedModules).toEqual([])
		expect(pluginNodeAddressEqual(nextAddress, originalAddress)).toBe(true)
		expect(pluginService.resolvePluginNode(nextAddress)).toBe(originalSlot)
		expect(ctx.loader.api.registry.getCtor(originalAddress)).toBe(DepNext)
		expect(nextConsumer?.dep.generation).toBe(2)
		expect(nextConsumer === firstConsumer).toBe(false)
		expect([depStarts, consumerStarts]).toEqual([2, 2])
	})

	it('replaces every running fork generation when one definition source changes', async () => {
		const { ctx } = createHmrTestContext()
		const starts = new Map<string, number>()

		@Plugin({ forkable: true })
		class Worker extends BasePlugin {
			readonly generation = 1

			override init() {
				const address = this.ctx.pluginInfo.nodeAddress
				const key = address.variant === 'fork' ? address.forkId : 'default'
				starts.set(key, (starts.get(key) ?? 0) + 1)
			}
		}
		lowerTestPlugin(Worker)
		const base = pluginNodeAddressOf(Worker)
		const fork = {
			definition: base.definition,
			variant: 'fork',
			forkId: 'east',
		} as const
		await ctx.loader.replaceModule('Worker.ts', { Worker })
		await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: base.definition, forkId: 'east' },
				{ type: 'set-enabled', node: base, enabled: true },
				{ type: 'set-enabled', node: fork, enabled: true },
			),
		)

		const pluginService = requirePluginService(ctx)
		const firstDefault = pluginService.getInstance(base)
		const firstFork = pluginService.getInstance(fork)

		const WorkerNext = class WorkerNext extends BasePlugin {
			readonly generation = 2

			override init() {
				const address = this.ctx.pluginInfo.nodeAddress
				const key = address.variant === 'fork' ? address.forkId : 'default'
				starts.set(key, (starts.get(key) ?? 0) + 1)
			}
		}
		Plugin({ forkable: true })(WorkerNext)
		lowerTestPlugin(WorkerNext, {
			exportName: 'Worker',
			path: 'tests/runtime-dynamic/Worker.ts',
		})
		await ctx.loader.replaceModule('Worker.ts', { Worker: WorkerNext })

		const nextDefault = pluginService.getInstance(base) as
			| InstanceType<typeof WorkerNext>
			| undefined
		const nextFork = pluginService.getInstance(fork) as InstanceType<typeof WorkerNext> | undefined
		expect(nextDefault?.generation).toBe(2)
		expect(nextFork?.generation).toBe(2)
		expect(nextDefault === firstDefault).toBe(false)
		expect(nextFork === firstFork).toBe(false)
		expect(starts).toEqual(
			new Map([
				['default', 2],
				['east', 2],
			]),
		)
	})

	it('rolls back catalog and constructor ownership when replacement graph build fails', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Stable dependency' })
		class Dep extends BasePlugin {}
		lowerTestPlugin(Dep)
		await ctx.loader.replaceModule('Dep.ts', { Dep })
		await enablePlugins(ctx, Dep)

		abstract class Missing extends BasePlugin {}
		lowerTestAbstract(Missing)

		@Plugin({ displayName: 'Broken generation' })
		class DepBroken extends BasePlugin {
			constructor(_missing: Missing) {
				super()
			}
		}
		const original = pluginDefinitionAddressOf(Dep)
		lowerTestPlugin(DepBroken, {
			exportName: original.exportName,
			sourceSpace: original.entry.kind === 'source-entry' ? original.entry.sourceSpace : 'app',
			path:
				original.entry.kind === 'source-entry'
					? original.entry.path
					: 'tests/runtime-dynamic/Dep.ts',
			requires: [Missing],
		})

		await expect(ctx.loader.replaceModule('Dep.ts', { Dep: DepBroken })).rejects.toMatchObject({
			code: 'graph_rejected',
		})

		const address = pluginNodeAddressOf(Dep)
		expect(ctx.loader.api.registry.getCtor(address)).toBe(Dep)
		expect(ctx.loader.api.registry.findModuleId(address)).toBe('Dep.ts')
		expect(requirePluginService(ctx).isRunning(address)).toBe(true)
	})

	it('applies structured dependency overrides across replacement generations', async () => {
		const { ctx } = createHmrTestContext()
		let consumerStarts = 0

		abstract class Dependency extends BasePlugin {
			abstract readonly kind: string
		}
		lowerTestAbstract(Dependency)

		@Plugin(Dependency, { displayName: 'A' })
		class DepA extends Dependency {
			readonly kind = 'A'
		}
		lowerTestPlugin(DepA, { provides: pluginDefinitionAddressOf(Dependency) })

		@Plugin(Dependency, { displayName: 'B' })
		class DepB extends Dependency {
			readonly kind = 'B'
			readonly generation = 1
		}
		lowerTestPlugin(DepB, { provides: pluginDefinitionAddressOf(Dependency) })

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly dep: Dependency) {
				super()
				consumerStarts++
			}
		}
		lowerTestPlugin(Consumer, { requires: [Dependency] })

		const batch = ctx.loader.beginBatch()
		await batch.replaceModule('DepA.ts', { DepA })
		await batch.replaceModule('DepB.ts', { DepB })
		await batch.replaceModule('Consumer.ts', { Consumer })
		await batch.commit()
		await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch(
				{
					type: 'set-dependency-override',
					consumer: pluginNodeAddressOf(Consumer),
					requirement: pluginDefinitionAddressOf(Dependency),
					provider: pluginNodeAddressOf(DepB),
				},
				...([DepA, DepB, Consumer] as const).map((PluginCtor) => ({
					type: 'set-enabled' as const,
					node: pluginNodeAddressOf(PluginCtor),
					enabled: true,
				})),
			),
		)

		const pluginService = requirePluginService(ctx)
		const firstConsumer = pluginService.getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(firstConsumer?.dep.kind).toBe('B')
		expect((firstConsumer?.dep as InstanceType<typeof DepB> | undefined)?.generation).toBe(1)

		const DepBNext = class DepBNext extends Dependency {
			readonly kind = 'B'
			readonly generation = 2
		}
		Plugin(Dependency, { displayName: 'B' })(DepBNext)
		lowerTestPlugin(DepBNext, {
			exportName: 'DepB',
			path: 'tests/runtime-dynamic/DepB.ts',
			provides: pluginDefinitionAddressOf(Dependency),
		})
		await ctx.loader.replaceModule('DepB.ts', { DepB: DepBNext })

		const nextConsumer = pluginService.getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(nextConsumer?.dep.kind).toBe('B')
		expect((nextConsumer?.dep as InstanceType<typeof DepBNext> | undefined)?.generation).toBe(2)
		expect(nextConsumer === firstConsumer).toBe(false)
		expect(consumerStarts).toBe(2)
	})

	it('lets Core restart an optional closure exactly once on appearance and removal', async () => {
		const { ctx } = createHmrTestContext()
		let consumerStarts = 0

		@Plugin({ displayName: 'Optional provider' })
		class OptionalProvider extends BasePlugin {}
		lowerTestPlugin(OptionalProvider)

		@Plugin({ displayName: 'Optional consumer' })
		class OptionalConsumer extends BasePlugin {
			override init() {
				consumerStarts++
			}
		}
		lowerTestPlugin(OptionalConsumer, { optional: [OptionalProvider] })

		const consumerBatch = ctx.loader.beginBatch()
		await consumerBatch.replaceModule('consumer.ts', { OptionalConsumer })
		await consumerBatch.commit({ statePatch: enablePluginsPatch(OptionalConsumer) })
		expect(consumerStarts).toBe(1)

		const providerBatch = ctx.loader.beginBatch()
		await providerBatch.replaceModule('provider.ts', { OptionalProvider })
		await providerBatch.commit({ statePatch: enablePluginsPatch(OptionalProvider) })
		expect(consumerStarts).toBe(2)

		await ctx.loader.pruneModule('provider.ts')
		expect(consumerStarts).toBe(3)
	})

	it('closes batch transactions after commit or rollback', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class Anchor extends BasePlugin {}
		lowerTestPlugin(Anchor)

		const committed = ctx.loader.beginBatch()
		await committed.replaceModule('Committed.ts', { Anchor })
		await committed.commit()
		await expect(committed.replaceModule('Committed.ts', { Anchor })).rejects.toThrow(
			/LoaderBatch is already closed/,
		)

		const rolledBack = ctx.loader.beginBatch()
		rolledBack.rollback()
		await expect(rolledBack.replaceModule('Committed.ts', { Anchor })).rejects.toThrow(
			/LoaderBatch is already closed/,
		)
	})
})
