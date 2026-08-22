import { describe, expect, it } from 'vitest'
import {
	clonePluginDefinition,
	getPluginDefinitionFacts,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/runtime/test'
import type { LoaderService } from '../../src/loader/LoaderService'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'
import { enablePlugins } from '../support/runtime-state'

type RuntimeUpdate = ReturnType<
	ReturnType<typeof createHmrTestContext>['core']['registry']['beginUpdate']
>
type RuntimeBatch = ReturnType<LoaderService['beginBatch']>

async function commitBatch(runtimeUpdate: RuntimeUpdate, batch: RuntimeBatch) {
	const result = await runtimeUpdate.commit({ rollbackOnFailure: false })
	expect(result).toMatchObject({ ok: true })
	batch.commit()
}

describe('LoaderService HMR lifecycle', () => {
	it('keeps the definition/node slot and restarts required dependents once', async () => {
		const { core, ctx } = createHmrTestContext()
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

		enablePlugins(ctx, Dep, Consumer)
		await ctx.loader.replaceModule('Dep.ts', { Dep })
		await ctx.loader.replaceModule('Consumer.ts', { Consumer })

		const originalAddress = pluginNodeAddressOf(Dep)
		const originalSlot = core.registry.internNodeAddress(originalAddress)
		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.dep.generation).toBe(1)
		expect([depStarts, consumerStarts]).toEqual([1, 1])

		class DepNext extends BasePlugin {
			readonly generation = 2
			override init() {
				depStarts++
			}
		}
		clonePluginDefinition(Dep, DepNext)

		const result = await ctx.loader.replaceModule('Dep.ts', { Dep: DepNext })
		const nextAddress = pluginNodeAddressOf(DepNext)
		const nextConsumer = core.registry.getInstance(Consumer)

		expect(new Set(result.affectedModules)).toEqual(new Set(['Consumer.ts', 'Dep.ts']))
		expect(pluginNodeAddressEqual(nextAddress, originalAddress)).toBe(true)
		expect(core.registry.internNodeAddress(nextAddress)).toBe(originalSlot)
		expect(ctx.loader.api.registry.getCtor(originalAddress)).toBe(DepNext)
		expect(nextConsumer?.dep.generation).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
		expect([depStarts, consumerStarts]).toEqual([2, 2])
	})

	it('replaces every running fork generation when one definition source changes', async () => {
		const { core, ctx } = createHmrTestContext()
		const starts = new Map<string, number>()

		@Plugin()
		class Worker extends ForkablePlugin {
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
		ctx.runtimeState.update((draft) => {
			draft.forks = [{ definition: base.definition, forkIds: ['east'] }]
		})
		enablePlugins(ctx, base, fork)
		await ctx.loader.replaceModule('Worker.ts', { Worker })

		const firstDefault = core.registry.getInstance(Worker)
		const firstForkCtor = ctx.loader.api.registry.getCtor(fork)!
		const firstFork = core.registry.getInstance(firstForkCtor)

		class WorkerNext extends ForkablePlugin {
			readonly generation = 2

			override init() {
				const address = this.ctx.pluginInfo.nodeAddress
				const key = address.variant === 'fork' ? address.forkId : 'default'
				starts.set(key, (starts.get(key) ?? 0) + 1)
			}
		}
		clonePluginDefinition(Worker, WorkerNext)
		await ctx.loader.replaceModule('Worker.ts', { Worker: WorkerNext })

		const nextDefault = core.registry.getInstance(WorkerNext)
		const nextForkCtor = ctx.loader.api.registry.getCtor(fork)!
		const nextFork = core.registry.getInstance(nextForkCtor) as
			| InstanceType<typeof WorkerNext>
			| undefined
		expect(nextDefault?.generation).toBe(2)
		expect(nextFork?.generation).toBe(2)
		expect(nextDefault).not.toBe(firstDefault)
		expect(nextFork).not.toBe(firstFork)
		expect(starts).toEqual(
			new Map([
				['default', 2],
				['east', 2],
			]),
		)
	})

	it('rolls back catalog and constructor ownership when replacement graph build fails', async () => {
		const { core, ctx } = createHmrTestContext()

		@Plugin({ displayName: 'Stable dependency' })
		class Dep extends BasePlugin {}
		lowerTestPlugin(Dep)
		enablePlugins(ctx, Dep)
		await ctx.loader.replaceModule('Dep.ts', { Dep })

		abstract class Missing extends BasePlugin {}
		lowerTestAbstract(Missing)

		@Plugin({ displayName: 'Broken generation' })
		class DepBroken extends BasePlugin {
			constructor(_missing: Missing) {
				super()
			}
		}
		const original = getPluginDefinitionFacts(Dep).definition
		lowerTestPlugin(DepBroken, {
			exportName: original.exportName,
			sourceSpace: original.entry.kind === 'source-entry' ? original.entry.sourceSpace : 'app',
			path:
				original.entry.kind === 'source-entry'
					? original.entry.path
					: 'tests/runtime-dynamic/Dep.ts',
			requires: [Missing],
		})

		await expect(ctx.loader.replaceModule('Dep.ts', { Dep: DepBroken })).rejects.toThrow(
			/Dynamic source commit failed/i,
		)

		const address = pluginNodeAddressOf(Dep)
		expect(ctx.loader.api.registry.getCtor(address)).toBe(Dep)
		expect(ctx.loader.api.registry.findModuleId(address)).toBe('Dep.ts')
		expect(core.registry.isRunning(Dep)).toBe(true)
	})

	it('applies structured dependency overrides across replacement generations', async () => {
		const { core, ctx } = createHmrTestContext()
		let consumerStarts = 0

		@Plugin({ displayName: 'A' })
		class DepA extends BasePlugin {
			readonly kind = 'A'
		}
		lowerTestPlugin(DepA)

		@Plugin({ displayName: 'B' })
		class DepB extends BasePlugin {
			readonly kind = 'B'
			readonly generation = 1
		}
		lowerTestPlugin(DepB)

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly dep: DepA) {
				super()
				consumerStarts++
			}
		}
		lowerTestPlugin(Consumer, { requires: [DepA] })

		enablePlugins(ctx, DepA, DepB, Consumer)
		ctx.runtimeState.update((draft) => {
			draft.dependencyOverrides = [
				{
					consumerAddress: pluginNodeAddressOf(Consumer),
					requirementAddress: getPluginDefinitionFacts(DepA).definition,
					providerAddress: pluginNodeAddressOf(DepB),
				},
			]
		})
		await ctx.loader.replaceModule('DepA.ts', { DepA })
		await ctx.loader.replaceModule('DepB.ts', { DepB })
		await ctx.loader.replaceModule('Consumer.ts', { Consumer })

		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.dep.kind).toBe('B')
		expect((firstConsumer?.dep as InstanceType<typeof DepB> | undefined)?.generation).toBe(1)

		class DepBNext extends BasePlugin {
			readonly kind = 'B'
			readonly generation = 2
		}
		clonePluginDefinition(DepB, DepBNext)
		await ctx.loader.replaceModule('DepB.ts', { DepB: DepBNext })

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.dep.kind).toBe('B')
		expect((nextConsumer?.dep as InstanceType<typeof DepBNext> | undefined)?.generation).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
		expect(consumerStarts).toBe(2)
	})

	it('lets Core restart an optional closure exactly once on appearance and removal', async () => {
		const { core, ctx } = createHmrTestContext()
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

		enablePlugins(ctx, OptionalConsumer, OptionalProvider)
		await ctx.loader.replaceModule('consumer.ts', { OptionalConsumer })
		expect(consumerStarts).toBe(1)

		await ctx.loader.replaceModule('provider.ts', { OptionalProvider })
		expect(consumerStarts).toBe(2)

		const runtimeUpdate = core.registry.beginUpdate({ reason: 'hmr' })
		const batch = ctx.loader.beginBatch({ runtimeUpdate })
		batch.removeModule('provider.ts')
		runtimeUpdate.markAffectedModules(['provider.ts', ...batch.getAffectedModules()])
		await batch.syncModules(batch.getAffectedModules(), { exclude: ['provider.ts'] })
		await commitBatch(runtimeUpdate, batch)
		expect(consumerStarts).toBe(3)
	})

	it('closes batch transactions after commit or rollback', async () => {
		const { ctx } = createHmrTestContext()

		@Plugin()
		class Anchor extends BasePlugin {}
		lowerTestPlugin(Anchor)

		const committed = ctx.loader.beginBatch()
		await committed.replaceModule('Committed.ts', { Anchor })
		committed.commit()
		await expect(committed.replaceModule('Committed.ts', { Anchor })).rejects.toThrow(
			/LoaderBatch is already closed/,
		)

		const rolledBack = ctx.loader.beginBatch()
		rolledBack.rollback()
		await expect(rolledBack.syncModules(['Committed.ts'])).rejects.toThrow(
			/LoaderBatch is already closed/,
		)
	})
})
