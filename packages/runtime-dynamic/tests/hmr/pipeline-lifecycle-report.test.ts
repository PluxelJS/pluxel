import { describe, expect, it, vi } from 'vitest'
import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginNodeAddress,
} from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import type { RuntimeHostConfig } from '@pluxel/runtime/internal/static-host'
import { createDynamicRouteContextCapabilities, requireLoaderService } from '../../src/context-plan'

import {
	collectDesiredButStopped,
	type DesiredButStoppedLookup,
	HmrExecutor,
} from '../../src/hmr/engine/pipeline'
import { lowerTestAbstract, lowerTestPlugin, lowerTestReplacement } from '../support/lowered-plugin'
import { pluginsAutoStartPatch, isAutoStartEnabled } from '../support/runtime-state'

function createDynamicInternalTestHost(config: RuntimeHostConfig = {}) {
	return createRuntimeInternalTestHost(
		{ workbench: false, ...config },
		{ routeContextCapabilities: createDynamicRouteContextCapabilities() },
	)
}

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
		const host = createDynamicInternalTestHost()
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
			expect(requireLoaderService(host.ctx).api.anchors.has(cleanId)).toBe(true)
			expect(
				requireLoaderService(host.ctx).api.registry.findModuleId(pluginNodeAddressOf(Anchor)),
			).toBe(cleanId)
		} finally {
			await host.dispose()
		}
	})

	it('publishes the replacement generation before one deduplicated dependent restart', async () => {
		const host = createDynamicInternalTestHost()
		try {
			let consumerStarts = 0

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

			const startup = requireLoaderService(host.ctx).beginBatch()
			await startup.replaceModule('/dep.ts', { Dep })
			await startup.replaceModule('/consumer.ts', { Consumer })
			await startup.commit({ statePatch: pluginsAutoStartPatch(true, Dep, Consumer) })

			const firstConsumer = host.require(Consumer)
			@Plugin({ displayName: 'Dependency' })
			class DepNext extends BasePlugin {
				readonly generation = 2
			}
			lowerTestReplacement(Dep, DepNext)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/dep.ts')
					return { Dep: DepNext }
				},
			})
			const result = await executor.runAndLoadAllClean(['/dep.ts'])

			expect(result?.commitResult.ok).toBe(true)
			expect(result?.affectedModules).toEqual([])
			expect(result?.syncedModules).toEqual([])
			const nextConsumer = host.require(Consumer)
			expect(nextConsumer === firstConsumer).toBe(false)
			expect(consumerStarts).toBe(2)
			expect(nextConsumer?.dep.generation).toBe(2)
		} finally {
			await host.dispose()
		}
	})

	it('activates artifacts only for accepted source batches and before replacement startup', async () => {
		const host = createDynamicInternalTestHost()
		try {
			let artifact = 'initial'
			@Plugin()
			class Stable extends BasePlugin {}
			lowerTestPlugin(Stable)
			const loader = requireLoaderService(host.ctx)
			const startup = loader.beginBatch()
			await startup.replaceModule('/stable.ts', { Stable })
			await startup.commit({ statePatch: pluginsAutoStartPatch(true, Stable) })
			const first = host.require(Stable)
			abstract class Missing extends BasePlugin {}
			lowerTestAbstract(Missing)
			@Plugin()
			class Invalid extends BasePlugin {}
			lowerTestReplacement(Stable, Invalid, { requires: [Missing] })
			const commit = vi.fn(() => {
				artifact = 'candidate'
				return []
			})
			const rollback = vi.fn()
			const rejected = await createExecutor(host.ctx, {
				importModule: () => ({ Stable: Invalid }),
				config: { beforeCommit: async () => ({ commit, rollback }) },
			}).runAndLoadAllClean(['/stable.ts'])
			expect(rejected?.commitResult.ok).toBe(false)
			expect(commit).not.toHaveBeenCalled()
			expect(rollback).toHaveBeenCalledOnce()
			expect(host.require(Stable)).toBe(first)
			expect(artifact).toBe('initial')

			@Plugin()
			class Next extends BasePlugin {
				readonly startupArtifact = artifact
			}
			lowerTestReplacement(Stable, Next)
			const accepted = await createExecutor(host.ctx, {
				importModule: () => ({ Stable: Next }),
				config: { beforeCommit: async () => ({ commit, rollback }) },
			}).runAndLoadAllClean(['/stable.ts'])
			expect(accepted?.commitResult.ok).toBe(true)
			expect(commit).toHaveBeenCalledOnce()
			expect(host.require(Next)?.startupArtifact).toBe('candidate')
		} finally {
			await host.dispose()
		}
	})

	it('keeps missing-dependency auto-start policy while reporting the node as desired but stopped', async () => {
		abstract class Missing extends BasePlugin {}
		lowerTestAbstract(Missing)

		@Plugin()
		class Broken extends BasePlugin {
			constructor(_missing: Missing) {
				super()
			}
		}
		lowerTestPlugin(Broken, { requires: [Missing] })

		const host = createDynamicInternalTestHost({
			runtimeState: {
				mode: 'memory',
				snapshot: { autoStart: [pluginNodeAddressOf(Broken)] },
			},
		})
		try {
			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/broken.ts')
					return { Broken }
				},
			})
			const result = await executor.runAndLoadAllClean(['/broken.ts'])

			expect(result?.commitResult.ok).toBe(true)
			expect(isAutoStartEnabled(host.ctx, Broken)).toBe(true)
			expect(host.isRunning(Broken)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('rolls back the entire source batch when evaluation fails', async () => {
		const host = createDynamicInternalTestHost()
		try {
			@Plugin()
			class Stable extends BasePlugin {}
			lowerTestPlugin(Stable)
			const startup = requireLoaderService(host.ctx).beginBatch()
			await startup.replaceModule('/stable.ts', { Stable })
			await startup.commit({ statePatch: pluginsAutoStartPatch(true, Stable) })
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
			expect(host.require(Stable)).toBe(firstStable)
			expect(requireLoaderService(host.ctx).api.registry.getCtor(pluginNodeAddressOf(Stable))).toBe(
				Stable,
			)
		} finally {
			await host.dispose()
		}
	})
})

describe('collectDesiredButStopped', () => {
	it('reports only address-owned stopped nodes in the batch module set', async () => {
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
		const loader: DesiredButStoppedLookup = {
			api: {
				registry: { findModuleId },
				status: {
					snapshot: async () => ({
						statuses: [
							{ address: inBatch, desiredState: 'running', lifecycleState: 'stopped' },
							{ address: elsewhere, desiredState: 'running', lifecycleState: 'stopped' },
						],
					}),
				},
			},
		}

		await expect(collectDesiredButStopped(loader, new Set(['/consumer.ts']))).resolves.toEqual([
			formatPluginNodeReference(inBatch),
		])
		expect(findModuleId).toHaveBeenCalledTimes(2)
	})
})
