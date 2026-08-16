import { describe, expect, it } from 'vitest'
import {
	clonePluginDefinition,
	getPluginDefinitionFacts,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/runtime/test'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'
import { enablePlugins } from '../support/runtime-state'

describe('base provider selection', () => {
	it('rejects a fork as provider default and persists the deterministic default node', async () => {
		const { core, ctx } = createHmrTestContext()

		abstract class Abs extends ForkablePlugin {}
		lowerTestAbstract(Abs)

		@Plugin(Abs, { displayName: 'Implementation' })
		class Impl extends Abs {}
		lowerTestPlugin(Impl, { provides: getPluginDefinitionFacts(Abs).definition })

		const implementation = pluginNodeAddressOf(Impl)
		const fork = {
			definition: implementation.definition,
			instance: 'fork',
			forkId: 'f1',
		} as const
		ctx.runtimeState.update((draft) => {
			draft.providerDefaults = [{ token: getPluginDefinitionFacts(Abs).definition, provider: fork }]
			draft.forks = [{ definition: implementation.definition, forkIds: ['f1'] }]
		})
		enablePlugins(ctx, implementation, fork)

		await ctx.loader.replaceModule('A.ts', { Impl })

		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(ctx.runtimeState.snapshot().providerDefaults).toEqual([
			{
				token: getPluginDefinitionFacts(Abs).definition,
				provider: implementation,
			},
		])
	})

	it('restarts consumers of a base token when its provider generation changes', async () => {
		const { core, ctx } = createHmrTestContext()
		let consumerStarts = 0

		abstract class Abs extends ForkablePlugin {
			abstract readonly generation: number
		}
		lowerTestAbstract(Abs)

		@Plugin(Abs, { displayName: 'Provider' })
		class Impl extends Abs {
			readonly generation = 1
		}
		lowerTestPlugin(Impl, { provides: getPluginDefinitionFacts(Abs).definition })

		@Plugin({ displayName: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(readonly dep: Abs) {
				super()
				consumerStarts++
			}
		}
		lowerTestPlugin(Consumer, { requires: [Abs] })

		enablePlugins(ctx, Impl, Consumer)
		await ctx.loader.replaceModule('Provider.ts', { Impl })
		await ctx.loader.replaceModule('Consumer.ts', { Consumer })
		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.dep.generation).toBe(1)

		class ImplNext extends Abs {
			readonly generation = 2
		}
		clonePluginDefinition(Impl, ImplNext)
		await ctx.loader.replaceModule('Provider.ts', { Impl: ImplNext })

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(pluginNodeAddressEqual(pluginNodeAddressOf(ImplNext), pluginNodeAddressOf(Impl))).toBe(
			true,
		)
		expect(nextConsumer?.dep.generation).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
		expect(consumerStarts).toBe(2)
	})

	it('preserves a structured fork override across provider replacement', async () => {
		const { core, ctx } = createHmrTestContext()
		let consumerStarts = 0

		@Plugin({ displayName: 'Worker' })
		class Worker extends ForkablePlugin {
			readonly generation = 1
		}
		lowerTestPlugin(Worker)

		@Plugin({ displayName: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(readonly dep: Worker) {
				super()
				consumerStarts++
			}
		}
		lowerTestPlugin(Consumer, { requires: [Worker] })

		const worker = pluginNodeAddressOf(Worker)
		const fork = {
			definition: worker.definition,
			instance: 'fork',
			forkId: 'f1',
		} as const
		ctx.runtimeState.update((draft) => {
			draft.forks = [{ definition: worker.definition, forkIds: ['f1'] }]
			draft.dependencyOverrides = [
				{ consumer: pluginNodeAddressOf(Consumer), parameterIndex: 0, provider: fork },
			]
		})
		enablePlugins(ctx, fork, Consumer)
		await ctx.loader.replaceModule('Provider.ts', { Worker })
		await ctx.loader.replaceModule('Consumer.ts', { Consumer })
		const firstConsumer = core.registry.getInstance(Consumer)
		expect(firstConsumer?.dep.generation).toBe(1)

		class WorkerNext extends ForkablePlugin {
			readonly generation = 2
		}
		clonePluginDefinition(Worker, WorkerNext)
		await ctx.loader.replaceModule('Provider.ts', { Worker: WorkerNext })

		const nextConsumer = core.registry.getInstance(Consumer)
		expect(nextConsumer?.dep.generation).toBe(2)
		expect(nextConsumer).not.toBe(firstConsumer)
		expect(ctx.loader.api.runtime.isRunning(fork)).toBe(true)
		expect(consumerStarts).toBe(2)
	})
})
