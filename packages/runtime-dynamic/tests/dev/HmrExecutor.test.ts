import { describe, expect, it, vi } from 'vitest'

import { HmrExecutor, prefetchTransforms } from '../../src/hmr/engine/pipeline'

describe('HmrExecutor', () => {
	it('marks invalid JavaScript evaluation as a failed batch result', async () => {
		const errorLogs: Array<{ message: string; props: unknown }> = []
		const batchRollback = vi.fn()
		const runtimeRollback = vi.fn()
		const replaceModule = vi.fn()
		const syntaxError = new SyntaxError('Unexpected token')

		const executor = new HmrExecutor(
			{
				logger: {
					error: (message: string, props?: unknown) => errorLogs.push({ message, props }),
				},
				registry: {
					beginUpdate: () => ({
						rollback: runtimeRollback,
						commit: vi.fn(),
					}),
				},
				loader: {
					beginBatch: () => ({
						replaceModule,
						rollback: batchRollback,
						commit: vi.fn(),
						getAffectedModules: () => [],
						syncModules: vi.fn(async () => []),
					}),
				},
			} as any,
			{
				import: vi.fn(async () => {
					throw syntaxError
				}),
			} as any,
			{
				variants: (id: string) => [id],
				variantsClean: (id: string) => [id],
				pretty: (id: string) => id,
				toClean: (id: string) => id,
			} as any,
			{
				start: () => () => 1,
			} as any,
			{} as any,
		)

		const result = await executor.runAndLoadAllClean(['/repo/plugin.ts'])

		expect(result?.commitResult.ok).toBe(false)
		expect(result?.executeError).toBe('Unexpected token')
		expect(batchRollback).toHaveBeenCalledTimes(1)
		expect(runtimeRollback).toHaveBeenCalledTimes(1)
		expect(replaceModule).not.toHaveBeenCalled()
		expect(errorLogs).toEqual([
			{
				message: 'execute failed for {file}',
				props: { file: '/repo/plugin.ts', error: syntaxError },
			},
		])
	})

	it('marks plugin injection failures as failed batch results', async () => {
		const errorLogs: Array<{ message: string; props: unknown }> = []
		const batchRollback = vi.fn()
		const runtimeRollback = vi.fn()
		const injectError = new Error('invalid plugin export')

		const executor = new HmrExecutor(
			{
				logger: {
					error: (message: string, props?: unknown) => errorLogs.push({ message, props }),
				},
				registry: {
					beginUpdate: () => ({
						rollback: runtimeRollback,
						commit: vi.fn(),
					}),
				},
				loader: {
					beginBatch: () => ({
						replaceModule: vi.fn(async () => {
							throw injectError
						}),
						rollback: batchRollback,
						commit: vi.fn(),
						getAffectedModules: () => [],
						syncModules: vi.fn(async () => []),
					}),
				},
			} as any,
			{ import: vi.fn(async () => ({ Plugin: class Plugin {} })) } as any,
			{
				variants: (id: string) => [id],
				variantsClean: (id: string) => [id],
				pretty: (id: string) => id,
				toClean: (id: string) => id,
			} as any,
			{
				start: () => () => 1,
			} as any,
			{} as any,
		)

		const result = await executor.runAndLoadAllClean(['/repo/plugin.ts'])

		expect(result?.commitResult.ok).toBe(false)
		expect(result?.injectError).toBe('invalid plugin export')
		expect(batchRollback).toHaveBeenCalledTimes(1)
		expect(runtimeRollback).toHaveBeenCalledTimes(1)
		expect(errorLogs).toEqual([
			{
				message: 'replaceModule failed for {file}',
				props: { file: '/repo/plugin.ts', error: injectError },
			},
		])
	})

	it('counts transform prefetch failures without failing the caller', async () => {
		const result = await prefetchTransforms({
			env: {
				fetchModule: vi.fn(async (id: string) => {
					if (id.endsWith('bad.ts')) throw new Error('syntax error')
				}),
			} as any,
			ids: ['/repo/good.ts', '/repo/bad.ts', '/repo/good.ts'],
			timing: { start: () => () => 0 } as any,
			concurrency: 2,
		})

		expect(result).toEqual({
			attempted: 2,
			failed: 1,
			failedIds: ['/repo/bad.ts'],
		})
	})
})
