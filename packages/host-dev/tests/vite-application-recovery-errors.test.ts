import { HOST_VITE_ENVIRONMENT } from '../src/environment'
import { EventEmitter } from 'node:events'
import type { ViteDevServer } from 'vite'
import { expect, it, vi } from 'vitest'
import { ViteApplicationRecovery } from '../src/internal/vite-application-recovery'
import {
	createHostDiagnostics,
	createViteDiagnostics,
	type HostDiagnostics,
} from '../src/internal/update-error'

const state = vi.hoisted(() => ({ watchers: [] as Array<import('node:events').EventEmitter> }))
vi.mock('chokidar', async () => {
	const { EventEmitter: WatcherEmitter } = await import('node:events')
	return {
		watch() {
			const watcher = Object.assign(new WatcherEmitter(), { close: async () => {} })
			state.watchers.push(watcher)
			queueMicrotask(() => watcher.emit('ready'))
			return watcher
		},
	}
})

it('reports recovery watcher and pre-update hook errors without duplicating candidate failures', async () => {
	const onError = vi.fn()
	const onChange = vi.fn(async () => {})
	const watchChange = vi.fn(async () => {})
	const logger = { error: vi.fn() }
	let currentLogger: HostDiagnostics | undefined
	const diagnostics = createHostDiagnostics(
		() => currentLogger,
		createViteDiagnostics(() => logger),
	)
	const recovery = new ViteApplicationRecovery(diagnostics)
	const entry = '/fixture/app.ts'
	recovery.attach(
		{
			config: { root: '/fixture', resolve: { extensions: [] }, server: { watch: {} }, logger },
			environments: {
				[HOST_VITE_ENVIRONMENT]: {
					moduleGraph: { getModulesByFile: () => new Set() },
					pluginContainer: { watchChange },
				},
			},
		} as unknown as ViteDevServer,
		onChange,
		onError,
	)
	try {
		recovery.begin(entry)
		const resolveId = recovery.plugin.resolveId
		if (typeof resolveId !== 'function') throw new Error('Missing resolution observer')
		await Reflect.apply(resolveId, { resolve: async () => null }, [
			'missing-package',
			entry,
			{ ssr: true },
		])
		await recovery.failed()
		const watcher = state.watchers.at(-1)!
		expect(watcher).toBeInstanceOf(EventEmitter)
		const watcherError = new Error('watcher unavailable')
		watcher.emit('error', watcherError)
		expect(onError).toHaveBeenCalledExactlyOnceWith(watcherError)

		const hookError = new Error('watchChange failed')
		watchChange.mockRejectedValueOnce(hookError)
		watcher.emit('add', '/fixture/node_modules/missing-package/package.json')
		await vi.waitFor(() => expect(onError).toHaveBeenLastCalledWith(hookError))
		expect(onChange).not.toHaveBeenCalled()

		const candidateError = new AggregateError(
			[
				new Error('provider preparation failed', {
					cause: new Error('database connection refused'),
				}),
			],
			'candidate rejected',
		)
		onChange.mockRejectedValueOnce(candidateError)
		watcher.emit('change', '/fixture/node_modules/missing-package/package.json')
		await vi.waitFor(() => expect(logger.error).toHaveBeenCalled())
		const [message, options] = logger.error.mock.calls[0]!
		expect(message).toContain('Application recovery update failed')
		expect(message).toContain('AggregateError: candidate rejected')
		expect(message).toContain('provider preparation failed')
		expect(message).toContain('database connection refused')
		expect(message).toContain('vite-application-recovery-errors.test.ts')
		expect(options).toEqual({ error: candidateError })
		const contextLogger = { error: vi.fn() }
		currentLogger = contextLogger
		onChange.mockRejectedValueOnce(candidateError)
		watcher.emit('change', '/fixture/node_modules/missing-package/package.json')
		await vi.waitFor(() =>
			expect(contextLogger.error).toHaveBeenCalledExactlyOnceWith(
				'Application recovery update failed',
				{ error: candidateError },
			),
		)
		expect(logger.error).toHaveBeenCalledOnce()
		const replacementLogger = { error: vi.fn() }
		currentLogger = replacementLogger
		diagnostics.error('replacement failure', { error: candidateError })
		expect(replacementLogger.error).toHaveBeenCalledExactlyOnceWith('replacement failure', {
			error: candidateError,
		})
		expect(contextLogger.error).toHaveBeenCalledOnce()
		currentLogger = undefined
		diagnostics.error('after close', { error: candidateError })
		expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('after close'), {
			error: candidateError,
		})
		expect(replacementLogger.error).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledTimes(2)
		await recovery.close()
		watcher.emit('error', new Error('late watcher error'))
		expect(onError).toHaveBeenCalledTimes(2)
	} finally {
		await recovery.close()
	}
})
