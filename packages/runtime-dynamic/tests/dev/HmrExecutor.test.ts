import { describe, expect, it, vi } from 'vitest'
import { createRuntimeHost } from '@pluxel/runtime/test'

import { createDynamicContextInstallations, requireLoaderService } from '../../src/context-plan'
import { HmrExecutor, prefetchTransforms } from '../../src/hmr/engine/pipeline'

type ExecutorOptions = {
	errorLogs: Array<{ message: string; props: unknown }>
	batchRollback: () => void
	importModule: (id: string) => Promise<Record<string, unknown>>
	replaceModule?: () => Promise<unknown> | unknown
}

function createExecutor(options: ExecutorOptions) {
	const host = createRuntimeHost(
		{ workbench: false },
		{ installations: createDynamicContextInstallations() },
	)
	const logger = host.ctx.logger as typeof host.ctx.logger & {
		error(message: string, props?: unknown): void
	}
	logger.error = (message: string, props?: unknown) => options.errorLogs.push({ message, props })
	const loader = requireLoaderService(host.ctx)
	loader.beginBatch = () =>
		({
			replaceModule: options.replaceModule ?? vi.fn(async () => ({})),
			removeModule: vi.fn(),
			rollback: options.batchRollback,
			commit: vi.fn(),
		}) as ReturnType<typeof loader.beginBatch>
	const executor = new HmrExecutor(
		host.ctx,
		{ import: options.importModule } as ConstructorParameters<typeof HmrExecutor>[1],
		{
			variants: (id: string) => [id],
			variantsClean: (id: string) => [id],
			pretty: (id: string) => id,
			toClean: (id: string) => id,
			toVite: (id: string) => id,
		} as ConstructorParameters<typeof HmrExecutor>[2],
		{ start: () => () => 1 },
		{ useRequireShims: false, dbgModules: null },
	)
	return { executor, dispose: () => host.dispose() }
}

describe('HmrExecutor', () => {
	it('marks invalid JavaScript evaluation as a failed batch result', async () => {
		const errorLogs: Array<{ message: string; props: unknown }> = []
		const batchRollback = vi.fn()
		const replaceModule = vi.fn()
		const syntaxError = new SyntaxError('Unexpected token')

		const fixture = createExecutor({
			errorLogs,
			batchRollback,
			replaceModule,
			importModule: vi.fn(async () => {
				throw syntaxError
			}),
		})

		try {
			const result = await fixture.executor.runAndLoadAllClean(['/repo/plugin.ts'])

			expect(result?.commitResult.ok).toBe(false)
			expect(result?.executeError).toBe('Unexpected token')
			expect(batchRollback).toHaveBeenCalledTimes(1)
			expect(replaceModule).not.toHaveBeenCalled()
			expect(errorLogs).toEqual([
				{
					message: 'execute failed for {file}',
					props: { file: '/repo/plugin.ts', error: syntaxError },
				},
			])
		} finally {
			await fixture.dispose()
		}
	})

	it('marks plugin injection failures as failed batch results', async () => {
		const errorLogs: Array<{ message: string; props: unknown }> = []
		const batchRollback = vi.fn()
		const injectError = new Error('invalid plugin export')

		const fixture = createExecutor({
			errorLogs,
			batchRollback,
			importModule: vi.fn(async () => ({ Plugin: class Plugin {} })),
			replaceModule: vi.fn(async () => {
				throw injectError
			}),
		})

		try {
			const result = await fixture.executor.runAndLoadAllClean(['/repo/plugin.ts'])

			expect(result?.commitResult.ok).toBe(false)
			expect(result?.injectError).toBe('invalid plugin export')
			expect(batchRollback).toHaveBeenCalledTimes(1)
			expect(errorLogs).toEqual([
				{
					message: 'replaceModule failed for {file}',
					props: { file: '/repo/plugin.ts', error: injectError },
				},
			])
		} finally {
			await fixture.dispose()
		}
	})

	it('counts transform prefetch failures without failing the caller', async () => {
		const result = await prefetchTransforms({
			env: {
				fetchModule: vi.fn(async (id: string) => {
					if (id.endsWith('bad.ts')) throw new Error('syntax error')
				}),
			},
			ids: ['/repo/good.ts', '/repo/bad.ts', '/repo/good.ts'],
			timing: { start: () => () => 0 },
			concurrency: 2,
		})

		expect(result).toEqual({
			attempted: 2,
			failed: 1,
			failedIds: ['/repo/bad.ts'],
		})
	})
})
