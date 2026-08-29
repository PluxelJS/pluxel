import { describe, expect, it } from 'vitest'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import {
	requireRuntimePluginGraphCoordinator,
	requireRuntimeStateStore,
	runtimeStatePatch,
} from '@pluxel/runtime/internal'
import { requireLoaderService } from '../../src/context-plan'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'
import { setPluginsAutoStart, startPlugins } from '../support/runtime-state'

describe('base provider selection', () => {
	it('rejects a fork as provider default and persists the deterministic default node', async () => {
		const { ctx } = createHmrTestContext()

		abstract class Abs extends BasePlugin {}
		lowerTestAbstract(Abs)

		@Plugin(Abs, { displayName: 'Implementation', forkable: true })
		class Impl extends Abs {}
		lowerTestPlugin(Impl, { provides: pluginDefinitionAddressOf(Abs) })

		const implementation = pluginNodeAddressOf(Impl)
		const fork = {
			definition: implementation.definition,
			variant: 'fork',
			forkId: 'f1',
		} as const
		await requireLoaderService(ctx).replaceModule('A.ts', { Impl })
		const coordinator = requireRuntimePluginGraphCoordinator(ctx)
		await coordinator.updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: implementation.definition, forkId: 'f1' },
				{ type: 'set-auto-start', node: implementation, autoStart: true },
				{ type: 'set-auto-start', node: fork, autoStart: true },
			),
		)
		await startPlugins(ctx, implementation, fork)
		await expect(
			coordinator.updateRuntimeState(
				runtimeStatePatch({
					type: 'set-provider-default',
					token: pluginDefinitionAddressOf(Abs),
					provider: fork,
				}),
			),
		).rejects.toMatchObject({ code: 'fork_default_forbidden' })

		expect(requirePluginService(ctx).isRunning(implementation)).toBe(true)
		expect(requireRuntimeStateStore(ctx).snapshot().providerDefaults).toEqual([
			{
				token: pluginDefinitionAddressOf(Abs),
				provider: implementation,
			},
		])
	})

	it('restarts consumers of a base token when its provider generation changes', async () => {
		const { ctx } = createHmrTestContext()
		let consumerStarts = 0

		abstract class Abs extends BasePlugin {
			abstract readonly generation: number
		}
		lowerTestAbstract(Abs)

		@Plugin(Abs, { displayName: 'Provider' })
		class Impl extends Abs {
			readonly generation = 1
		}
		lowerTestPlugin(Impl, { provides: pluginDefinitionAddressOf(Abs) })

		@Plugin()
		class Consumer extends BasePlugin {
			constructor(readonly dep: Abs) {
				super()
				consumerStarts++
			}
		}
		lowerTestPlugin(Consumer, { requires: [Abs] })

		await requireLoaderService(ctx).replaceModule('Provider.ts', { Impl })
		await requireLoaderService(ctx).replaceModule('Consumer.ts', { Consumer })
		await setPluginsAutoStart(ctx, true, Impl, Consumer)
		await startPlugins(ctx, Impl, Consumer)
		const firstConsumer = requirePluginService(ctx).getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(firstConsumer?.dep.generation).toBe(1)

		const ImplNext = class ImplNext extends Abs {
			readonly generation = 2
		}
		Plugin(Abs, { displayName: 'Provider' })(ImplNext)
		lowerTestPlugin(ImplNext, {
			exportName: 'Impl',
			path: 'tests/runtime-dynamic/Impl.ts',
			provides: pluginDefinitionAddressOf(Abs),
		})
		await requireLoaderService(ctx).replaceModule('Provider.ts', { Impl: ImplNext })

		const nextConsumer = requirePluginService(ctx).getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(pluginNodeAddressEqual(pluginNodeAddressOf(ImplNext), pluginNodeAddressOf(Impl))).toBe(
			true,
		)
		expect(nextConsumer?.dep.generation).toBe(2)
		expect(nextConsumer === firstConsumer).toBe(false)
		expect(consumerStarts).toBe(2)
	})

	it('preserves a structured fork override across provider replacement', async () => {
		const { ctx } = createHmrTestContext()
		let consumerStarts = 0

		@Plugin({ forkable: true })
		class Worker extends BasePlugin {
			readonly generation = 1
		}
		lowerTestPlugin(Worker)

		@Plugin()
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
			variant: 'fork',
			forkId: 'f1',
		} as const
		await requireLoaderService(ctx).replaceModule('Provider.ts', { Worker })
		await requireLoaderService(ctx).replaceModule('Consumer.ts', { Consumer })
		await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: worker.definition, forkId: 'f1' },
				{
					type: 'set-dependency-override',
					consumer: pluginNodeAddressOf(Consumer),
					requirement: pluginDefinitionAddressOf(Worker),
					provider: fork,
				},
				{ type: 'set-auto-start', node: fork, autoStart: true },
				{ type: 'set-auto-start', node: pluginNodeAddressOf(Consumer), autoStart: true },
			),
		)
		await startPlugins(ctx, fork, Consumer)
		const firstConsumer = requirePluginService(ctx).getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(firstConsumer?.dep.generation).toBe(1)

		const WorkerNext = class WorkerNext extends BasePlugin {
			readonly generation = 2
		}
		Plugin({ forkable: true })(WorkerNext)
		lowerTestPlugin(WorkerNext, {
			exportName: 'Worker',
			path: 'tests/runtime-dynamic/Worker.ts',
		})
		await requireLoaderService(ctx).replaceModule('Provider.ts', { Worker: WorkerNext })

		const nextConsumer = requirePluginService(ctx).getInstance(pluginNodeAddressOf(Consumer)) as
			| Consumer
			| undefined
		expect(nextConsumer?.dep.generation).toBe(2)
		expect(nextConsumer === firstConsumer).toBe(false)
		expect(requirePluginService(ctx).isRunning(fork)).toBe(true)
		expect(consumerStarts).toBe(2)
	})
})
