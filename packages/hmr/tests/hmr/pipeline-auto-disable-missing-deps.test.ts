import { describe, expect, it } from 'vitest'

import { HmrBatchProcessor, HmrExecutor } from '../../src/dev/hmr/pipeline'

function createBatchStub(options: {
	affected?: readonly string[]
	syncCalls?: string[]
	onCommit?: () => void
	onRollback?: () => void
}) {
	const affected = options.affected ?? []
	return {
		replaceModule: async () => ({ isAnchor: false, affectedModules: [] }),
		getAffectedModules: () => affected,
		syncModules: async (ids: Iterable<string>) => {
			const synced: string[] = []
			for (const id of ids) {
				options.syncCalls?.push(id)
				synced.push(id)
			}
			return synced
		},
		commit: () => options.onCommit?.(),
		rollback: () => options.onRollback?.(),
	}
}

function createExecutor(ctx: any, options: Record<string, unknown> = {}) {
	const runner = { import: async () => ({}) } as any
	const path = {
		variants: (id: string) => [id],
		variantsClean: (id: string) => [id],
		pretty: (id: string) => id,
	} as any
	const timing = { start: () => () => 0 } as any

	return new HmrExecutor(ctx, runner, path, timing, {
		useRequireShims: false,
		dbgModules: null,
		...options,
	})
}

describe('HmrExecutor commit retry', () => {
	it('syncs runtime-reported affected modules before commit', async () => {
		const syncCalls: string[] = []
		let commitCalls = 0
		let didBatchCommit = false

		const loader = {
			beginBatch: () =>
				createBatchStub({
					affected: ['/dep.ts', '/consumer.ts'],
					syncCalls,
					onCommit: () => {
						didBatchCommit = true
					},
				}),
			api: {
				registry: {
					listRegistered: () => new Map<string, unknown>(),
				},
			},
		}

		const ctx = {
			loader,
			registry: {
				commit: async () => {
					commitCalls++
					return { ok: true as const, val: null }
				},
				resetDraft: () => {},
			},
			configService: {
				isEnabledInConfig: () => false,
				disableInConfig: () => {},
				batch: (run: () => void) => run(),
			},
			logger: { warn: () => {}, error: () => {} },
		} as any

		const executor = createExecutor(ctx)

		const out = await executor.runAndLoadAllClean(['/dep.ts'])
		expect(out?.res.ok).toBe(true)
		expect(out?.affectedModules).toEqual(['/dep.ts', '/consumer.ts'])
		expect(out?.syncedModules).toEqual(['/consumer.ts'])
		expect(out?.autoDisabled).toEqual([])
		expect(commitCalls).toBe(1)
		expect(syncCalls).toEqual(['/consumer.ts'])
		expect(didBatchCommit).toBe(true)
	})

	it('auto-disables missing-deps plugins and commits the rest', async () => {
		const enabled = new Set<string>(['UniverLoopbackPlugin', 'Other'])
		const disabledCalls: string[] = []
		const syncCalls: string[] = []
		let commitCalls = 0
		let didBatchCommit = false
		let didBatchRollback = false
		let didResetDraft = false

		const configService = {
			isEnabledInConfig: (name: string) => enabled.has(name),
			disableInConfig: (name: string) => {
				enabled.delete(name)
				disabledCalls.push(name)
			},
			batch: (run: () => void) => run(),
		}

		const loader = {
			beginBatch: () =>
				createBatchStub({
					syncCalls,
					onCommit: () => {
						didBatchCommit = true
					},
					onRollback: () => {
						didBatchRollback = true
					},
				}),
			api: {
				registry: {
					listRegistered: () =>
						new Map<string, unknown>([
							['UniverLoopbackPlugin', function UniverLoopbackPlugin() {}],
							['Other', function Other() {}],
						]),
				},
			},
		}

		const registry = {
			commit: async () => {
				commitCalls++
				if (commitCalls === 1) {
					return {
						ok: false as const,
						err: new Error('[MissingDependency] Otlp | chain: UniverLoopbackPlugin -> Otlp'),
					}
				}
				return { ok: true as const, val: null }
			},
			resetDraft: () => {
				didResetDraft = true
			},
		}

		const ctx = {
			loader,
			registry,
			configService,
			logger: {
				warn: () => {},
				error: () => {},
			},
		} as any

		const executor = createExecutor(ctx, {
			autoDisableMissingDependencies: true,
			autoDisableMaxPasses: 3,
		})

		const out = await executor.runAndLoadAllClean(['/fake.ts'])
		expect(out?.res.ok).toBe(true)
		expect(out?.affectedModules).toEqual([])
		expect(out?.syncedModules).toEqual(['/fake.ts'])
		expect(out?.autoDisabled).toEqual(['UniverLoopbackPlugin'])
		expect(commitCalls).toBe(2)
		expect(disabledCalls).toEqual(['UniverLoopbackPlugin'])
		expect(syncCalls).toEqual(['/fake.ts'])
		expect(didBatchCommit).toBe(true)
		expect(didBatchRollback).toBe(false)
		expect(didResetDraft).toBe(false)
		expect(enabled.has('UniverLoopbackPlugin')).toBe(false)
	})
})

describe('HmrBatchProcessor summary', () => {
	it('reports enabled-but-stopped plugins within the batch-related module set', async () => {
		const ctx = {
			loader: {
				api: {
					registry: {
						listRegistered: () => new Map(),
						findModuleIdByName: (name: string) =>
							name === 'StoppedInBatch'
								? '/consumer.ts'
								: name === 'StoppedElsewhere'
									? '/other.ts'
									: null,
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
			registry: { graph: { activeCount: () => 0 } },
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
	})
})
