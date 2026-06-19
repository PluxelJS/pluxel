import { describe, expect, it, vi } from 'vitest'
import '@pluxel/runtime-dynamic/register'
import { BasePlugin, createRuntimeHost, Plugin, setParamToken } from '@pluxel/runtime/test'

import { HmrBatchProcessor, HmrExecutor } from '../../src/hmr/engine/pipeline'

function defineParamTypes(ctor: unknown, paramTypes: unknown[]) {
	;(Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void })
		.defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

function createExecutor(
	ctx: any,
	options: {
		importModule?: (id: string) => Promise<Record<string, unknown>> | Record<string, unknown>
		config?: Record<string, unknown>
	} = {},
) {
	const runner = { import: async (id: string) => options.importModule?.(id) ?? {} } as any
	const path = {
		variants: (id: string) => [id],
		variantsClean: (id: string) => [id],
		pretty: (id: string) => id,
	} as any
	const timing = { start: () => () => 0 } as any

	return new HmrExecutor(ctx, runner, path, timing, {
		useRequireShims: false,
		dbgModules: null,
		...options.config,
	})
}

describe('HmrExecutor commit retry', () => {
	it('syncs runtime-reported affected modules before commit', async () => {
		const host = createRuntimeHost()
		try {
			let depSeq = 0
			let consumerSeq = 0
			let moduleItemsSeenDuringHmrCommit: Function[] = []

			class Dep extends BasePlugin {
				readonly seq = ++depSeq
			}
			Plugin({ name: 'Dep' })(Dep)

			class Consumer extends BasePlugin {
				readonly seq = ++consumerSeq

				constructor(readonly dep: Dep) {
					super()
				}
			}
			defineParamTypes(Consumer, [Dep])
			Plugin({ name: 'Consumer' })(Consumer)
			setParamToken(Consumer, 0, Dep)

			host.ctx.configService.enableInConfig('Dep', 'Consumer')
			await host.ctx.loader.replaceModule('/dep.ts', { Dep })
			await host.ctx.loader.replaceModule('/consumer.ts', { Consumer })
			await host.commit()
			host.ctx.on('afterCommit', (summary: { reason?: string }) => {
				if (summary.reason !== 'hmr') return
				moduleItemsSeenDuringHmrCommit = host.ctx.registry
					.listRuntimeModuleItems('/dep.ts')
					.map((item: { ctor: Function }) => item.ctor)
			})

			const firstConsumer = host.get(Consumer)
			expect(firstConsumer?.seq).toBe(1)
			expect(firstConsumer?.dep.seq).toBe(1)

			class DepNext extends BasePlugin {
				readonly seq = ++depSeq
			}
			Plugin({ name: 'Dep' })(DepNext)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/dep.ts')
					return { Dep: DepNext }
				},
			})

			const out = await executor.runAndLoadAllClean(['/dep.ts'])
			expect(out?.res.ok).toBe(true)
			expect(new Set(out?.affectedModules)).toEqual(new Set(['/dep.ts', '/consumer.ts']))
			expect(out?.syncedModules).toEqual(['/consumer.ts'])
			expect(out?.autoDisabled).toEqual([])
			expect(host.ctx.registry.lastCommit?.reason).toBe('hmr')
			expect(new Set(host.ctx.registry.lastCommit?.touchedModules)).toEqual(
				new Set(['/dep.ts', '/consumer.ts']),
			)
			expect(moduleItemsSeenDuringHmrCommit).toEqual([DepNext])

			const nextConsumer = host.get(Consumer)
			expect(nextConsumer?.seq).toBe(2)
			expect(nextConsumer?.dep.seq).toBe(2)
			expect(nextConsumer).not.toBe(firstConsumer)
		} finally {
			await host.dispose()
		}
	})

	it('auto-disables missing-deps plugins and commits the rest', async () => {
		const host = createRuntimeHost()
		try {
			abstract class MissingBase extends BasePlugin {}

			class Broken extends BasePlugin {
				constructor(_dep: MissingBase) {
					super()
				}
			}
			defineParamTypes(Broken, [MissingBase])
			Plugin({ name: 'Broken' })(Broken)
			setParamToken(Broken, 0, MissingBase)

			host.ctx.configService.enableInConfig('Broken')

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/broken.ts')
					return { Broken }
				},
				config: {
					autoDisableMissingDependencies: true,
					autoDisableMaxPasses: 3,
				},
			})

			const out = await executor.runAndLoadAllClean(['/broken.ts'])
			expect(out?.res.ok).toBe(true)
			expect(out?.affectedModules).toEqual([])
			expect(out?.syncedModules).toEqual(['/broken.ts'])
			expect(out?.autoDisabled).toEqual(['Broken'])
			expect(host.ctx.registry.lastCommit?.autoDisabled).toEqual(['Broken'])
			expect(host.ctx.configService.isEnabledInConfig('Broken')).toBe(false)
			expect(host.isRunning(Broken)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('does not replay modules whose runner evaluation failed during commit retry', async () => {
		const host = createRuntimeHost()
		try {
			let stableSeq = 0

			class Stable extends BasePlugin {
				readonly seq = ++stableSeq
			}
			Plugin({ name: 'Stable' })(Stable)

			abstract class MissingBase extends BasePlugin {}

			class Broken extends BasePlugin {
				constructor(_dep: MissingBase) {
					super()
				}
			}
			defineParamTypes(Broken, [MissingBase])
			Plugin({ name: 'Broken' })(Broken)
			setParamToken(Broken, 0, MissingBase)

			host.ctx.configService.enableInConfig('Stable', 'Broken')
			await host.ctx.loader.replaceModule('/stable.ts', { Stable })
			await host.commit()

			const firstStable = host.require(Stable)
			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					if (id === '/stable.ts') throw new Error('syntax error')
					if (id === '/broken.ts') return { Broken }
					return {}
				},
				config: {
					autoDisableMissingDependencies: true,
					autoDisableMaxPasses: 3,
				},
			})

			const out = await executor.runAndLoadAllClean(['/stable.ts', '/broken.ts'])
			expect(out?.res.ok).toBe(true)
			expect(out?.syncedModules).toEqual(['/broken.ts'])
			expect(out?.autoDisabled).toEqual(['Broken'])
			expect(host.ctx.registry.lastCommit?.autoDisabled).toEqual(['Broken'])
			expect(host.require(Stable)).toBe(firstStable)
		} finally {
			await host.dispose()
		}
	})
})

describe('HmrBatchProcessor summary', () => {
	it('reports enabled-but-stopped plugins within the batch-related module set', async () => {
		const findModuleIdByName = vi.fn((name: string) =>
			name === 'StoppedElsewhere' ? '/other.ts' : null,
		)
		const ctx = {
			loader: {
				api: {
					registry: {
						listRegistered: () => new Map(),
						findModuleIdByName,
					},
					status: {
						snapshot: () => ({
							statuses: {
								StoppedInBatch: { isEnabled: true, isRunning: false },
								StoppedElsewhere: { isEnabled: true, isRunning: false },
								RunningInBatch: { isEnabled: true, isRunning: true },
							},
						}),
					},
					anchors: {
						has: () => false,
						remove: () => {},
					},
				},
				pruneModule: () => {},
			},
			registry: {
				getRuntimeModuleId: (name: string) =>
					name === 'StoppedInBatch' ? '/consumer.ts' : undefined,
				graph: { activeCount: () => 0 },
			},
			configService: { isEnabledInConfig: () => false },
			logger: { info: () => {}, warn: () => {}, error: () => {} },
		} as any
		const env = {
			moduleGraph: {
				getModulesByFile: (id: string) =>
					id === '/consumer.ts'
						? new Set([{ id: '/consumer.ts', importers: new Set() }])
						: undefined,
				getModuleById: () => undefined,
				invalidateModule: () => {},
			},
			fetchModule: async () => {},
		} as any
		const executor = {
			runAndLoadAllClean: async () => ({
				res: { ok: true as const, val: null },
				commitMs: 1,
				affectedModules: ['/consumer.ts'],
				syncedModules: ['/consumer.ts'],
				autoDisabled: [],
			}),
		} as any
		const path = {
			toClean: (id: string) => id,
			variants: (id: string) => [id],
			variantsClean: (id: string) => [id],
			pretty: (id: string) => id,
		} as any
		const toolkit = { pathFilter: () => true } as any
		const timing = {
			clear: () => {},
			start: () => () => 0,
			entries: () => [],
			snapshot: () => ({ evalMs: new Map(), injectMs: new Map(), transformMs: new Map() }),
		} as any
		const processor = new HmrBatchProcessor(
			ctx,
			env,
			{ invalidateRunnerCacheByFiles: () => ({ invalidated: 0, invalidatedKeys: [] }) } as any,
			executor,
			path,
			toolkit,
			timing,
			{ attributionLevel: 'off', prefetchLimit: 0, prefetchOrder: 'near', prefetchConcurrency: 0 },
			{ batch: null, cache: null, graph: null },
			() => new Set(['/consumer.ts']),
		)

		const summary = await processor.process(['/consumer.ts'], 1)
		expect(summary?.enabledButStopped).toEqual(['StoppedInBatch'])
		expect(findModuleIdByName).not.toHaveBeenCalledWith('StoppedInBatch')
	})
})
