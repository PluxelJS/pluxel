import { describe, expect, it, vi } from 'vitest'
import '../../src/register-services'
import {
	clonePluginDefinition,
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginNodeAddress,
} from '@pluxel/core'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'

import {
	collectEnabledButStopped,
	type EnabledButStoppedLookupContext,
	HmrExecutor,
} from '../../src/hmr/engine/pipeline'
import { lowerTestAbstract, lowerTestPlugin } from '../support/lowered-plugin'
import { enablePlugins, isEnabled } from '../support/runtime-state'

function createExecutor(
	ctx: ConstructorParameters<typeof HmrExecutor>[0],
	options: {
		importModule?: (id: string) => Promise<Record<string, unknown>> | Record<string, unknown>
		config?: Partial<ConstructorParameters<typeof HmrExecutor>[4]>
		path?: Partial<ConstructorParameters<typeof HmrExecutor>[2]>
	} = {},
) {
	const runner: ConstructorParameters<typeof HmrExecutor>[1] = {
		import: async (id: string) => options.importModule?.(id) ?? {},
	}
	const path = {
		variants: (id: string) => [id],
		variantsClean: (id: string) => [id],
		toClean: (id: string) => id,
		toVite: (id: string) => id,
		pretty: (id: string) => id,
		...options.path,
	} as ConstructorParameters<typeof HmrExecutor>[2]
	const timing: ConstructorParameters<typeof HmrExecutor>[3] = { start: () => () => 0 }

	return new HmrExecutor(ctx, runner, path, timing, {
		useRequireShims: false,
		dbgModules: null,
		...options.config,
	})
}

describe('HmrExecutor transactions', () => {
	it('imports /@fs ids while keeping clean module ownership', async () => {
		const host = createRuntimeHost()
		try {
			const cleanId = '/repo/plugins/a/src/index.ts'
			const calls: string[] = []

			@Plugin()
			class Anchor extends BasePlugin {}
			lowerTestPlugin(Anchor)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					calls.push(id)
					if (id === `/@fs${cleanId}`) return { Anchor }
					throw new Error(`unexpected id: ${id}`)
				},
				path: {
					variants: (id) => [id, `/@fs${id}`],
					variantsClean: (id) => [id, `/@fs${id}`],
				},
			})

			const result = await executor.runAndLoadAllClean([cleanId])
			expect(result?.commitResult.ok).toBe(true)
			expect(calls).toEqual([`/@fs${cleanId}`])
			expect(host.ctx.loader.api.anchors.has(cleanId)).toBe(true)
			expect(host.ctx.loader.api.registry.findModuleId(pluginNodeAddressOf(Anchor))).toBe(cleanId)
		} finally {
			await host.dispose()
		}
	})

	it('publishes the replacement generation before one deduplicated dependent restart', async () => {
		const host = createRuntimeHost()
		try {
			let consumerStarts = 0
			let moduleItemsSeenDuringCommit: Function[] = []

			@Plugin({ displayName: 'Dependency' })
			class Dep extends BasePlugin {
				readonly generation = 1
			}
			lowerTestPlugin(Dep)

			@Plugin()
			class Consumer extends BasePlugin {
				constructor(readonly dep: Dep) {
					super()
					consumerStarts++
				}
			}
			lowerTestPlugin(Consumer, { requires: [Dep] })

			enablePlugins(host.ctx, Dep, Consumer)
			await host.ctx.loader.replaceModule('/dep.ts', { Dep })
			await host.ctx.loader.replaceModule('/consumer.ts', { Consumer })
			const unsubscribe = host.ctx.registry.subscribeCommitted((summary) => {
				if (summary.runtimeUpdate?.reason !== 'hmr') return
				moduleItemsSeenDuringCommit = host.ctx.registry
					.listRuntimeModuleItems('/dep.ts')
					.map((item) => item.ctor)
			})

			const firstConsumer = host.get(Consumer)
			class DepNext extends BasePlugin {
				readonly generation = 2
			}
			clonePluginDefinition(Dep, DepNext)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/dep.ts')
					return { Dep: DepNext }
				},
			})
			const result = await executor.runAndLoadAllClean(['/dep.ts'])
			unsubscribe()

			expect(result?.commitResult.ok).toBe(true)
			expect(new Set(result?.affectedModules)).toEqual(new Set(['/dep.ts', '/consumer.ts']))
			expect(result?.syncedModules).toEqual(['/consumer.ts'])
			expect(moduleItemsSeenDuringCommit).toEqual([DepNext])
			const nextConsumer = host.get(Consumer)
			expect(nextConsumer?.dep.generation).toBe(2)
			expect(nextConsumer).not.toBe(firstConsumer)
			expect(consumerStarts).toBe(2)
		} finally {
			await host.dispose()
		}
	})

	it('auto-disables missing-dependency node slots and commits the remaining batch', async () => {
		const host = createRuntimeHost()
		try {
			abstract class Missing extends BasePlugin {}
			lowerTestAbstract(Missing)

			@Plugin()
			class Broken extends BasePlugin {
				constructor(_missing: Missing) {
					super()
				}
			}
			lowerTestPlugin(Broken, { requires: [Missing] })
			enablePlugins(host.ctx, Broken)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/broken.ts')
					return { Broken }
				},
				config: { autoDisableMissingDependencies: true, autoDisableMaxPasses: 3 },
			})
			const result = await executor.runAndLoadAllClean(['/broken.ts'])
			const formatted = formatPluginNodeReference(pluginNodeAddressOf(Broken))

			expect(result?.commitResult.ok).toBe(true)
			expect(result?.autoDisabled).toEqual([formatted])
			expect(host.ctx.registry.lastCommit?.runtimeUpdate.autoDisabled).toEqual([
				host.ctx.registry.internNodeAddress(pluginNodeAddressOf(Broken)),
			])
			expect(isEnabled(host.ctx, Broken)).toBe(false)
			expect(host.isRunning(Broken)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('rolls back the entire source batch when evaluation fails', async () => {
		const host = createRuntimeHost()
		try {
			@Plugin()
			class Stable extends BasePlugin {}
			lowerTestPlugin(Stable)
			enablePlugins(host.ctx, Stable)
			await host.ctx.loader.replaceModule('/stable.ts', { Stable })
			const firstStable = host.require(Stable)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					if (id === '/stable.ts') throw new Error('syntax error')
					return {}
				},
			})
			const result = await executor.runAndLoadAllClean(['/stable.ts'])

			expect(result?.commitResult.ok).toBe(false)
			expect(result?.executeError).toBe('syntax error')
			expect(result?.syncedModules).toEqual([])
			expect(result?.autoDisabled).toEqual([])
			expect(host.require(Stable)).toBe(firstStable)
			expect(host.ctx.loader.api.registry.getCtor(pluginNodeAddressOf(Stable))).toBe(Stable)
		} finally {
			await host.dispose()
		}
	})
})

describe('collectEnabledButStopped', () => {
	it('reports only address-owned stopped nodes in the batch module set', () => {
		const inBatch: PluginNodeAddress = {
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'app', path: 'consumer.ts' },
				exportName: 'StoppedInBatch',
			},
			variant: 'default',
		}
		const elsewhere: PluginNodeAddress = {
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'app', path: 'other.ts' },
				exportName: 'StoppedElsewhere',
			},
			variant: 'default',
		}
		const findModuleId = vi.fn((address: PluginNodeAddress) =>
			pluginNodeAddressEqual(address, inBatch) ? '/consumer.ts' : '/other.ts',
		)
		const ctx: EnabledButStoppedLookupContext = {
			loader: {
				api: {
					registry: { findModuleId },
					status: {
						snapshot: () => ({
							statuses: [
								{ address: inBatch, isEnabled: true, isRunning: false },
								{ address: elsewhere, isEnabled: true, isRunning: false },
							],
						}),
					},
				},
			},
		}

		expect(collectEnabledButStopped(ctx, new Set(['/consumer.ts']))).toEqual([
			formatPluginNodeReference(inBatch),
		])
		expect(findModuleId).toHaveBeenCalledTimes(2)
	})
})
