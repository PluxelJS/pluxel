import { describe, expect, it } from 'vitest'

import { HmrExecutor } from '../../src/services/runtime/hmr/pipeline'

describe('HmrExecutor commit retry', () => {
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
			beginBatch: () => ({
				replaceModule: async () => false,
				commit: () => {
					didBatchCommit = true
				},
				rollback: () => {
					didBatchRollback = true
				},
			}),
			syncRuntimeForModule: async (id: string) => {
				syncCalls.push(id)
			},
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
						err: new Error(
							'[MissingDependency] Otlp | chain: UniverLoopbackPlugin -> Otlp',
						),
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
				warn: () => undefined,
				error: () => undefined,
			},
		} as any

		const runner = { import: async () => ({}) } as any
		const path = {
			variants: (id: string) => [id],
			variantsClean: (id: string) => [id],
			pretty: (id: string) => id,
		} as any
		const timing = { start: () => () => 0 } as any

		const executor = new HmrExecutor(ctx, runner, path, timing, {
			useRequireShims: false,
			dbgModules: null,
			autoDisableMissingDependencies: true,
			autoDisableMaxPasses: 3,
		})

		const out = await executor.runAndLoadAllClean(['/fake.ts'])
		expect(out?.res.ok).toBe(true)
		expect(commitCalls).toBe(2)
		expect(disabledCalls).toEqual(['UniverLoopbackPlugin'])
		expect(syncCalls).toEqual(['/fake.ts'])
		expect(didBatchCommit).toBe(true)
		expect(didBatchRollback).toBe(false)
		expect(didResetDraft).toBe(false)
		expect(enabled.has('UniverLoopbackPlugin')).toBe(false)
	})
})
