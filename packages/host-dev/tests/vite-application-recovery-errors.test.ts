import { EventEmitter } from 'node:events'
import type { ViteDevServer } from 'vite'
import { expect, it, vi } from 'vitest'
import { ViteApplicationRecovery } from '../src/internal/vite-application-recovery'

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
	const recovery = new ViteApplicationRecovery()
	const entry = '/fixture/app.ts'
	recovery.attach(
		{
			config: { root: '/fixture', resolve: { extensions: [] }, server: { watch: {} }, logger },
			environments: {
				ssr: {
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

		const candidateError = new Error('candidate rejected')
		onChange.mockRejectedValueOnce(candidateError)
		watcher.emit('change', '/fixture/node_modules/missing-package/package.json')
		await vi.waitFor(() => expect(logger.error).toHaveBeenCalled())
		expect(onError).toHaveBeenCalledTimes(2)
		await recovery.close()
		watcher.emit('error', new Error('late watcher error'))
		expect(onError).toHaveBeenCalledTimes(2)
	} finally {
		await recovery.close()
	}
})
