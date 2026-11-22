import { expect, it, vi } from 'vitest'
import { closeOnHotReload } from '../src/hmr'

function context(data = {}) {
	return { data, dispose: vi.fn(), on: vi.fn() }
}

it('propagates Host close results through both Vite disposal paths', async () => {
	const hot = context()
	const closing = Promise.withResolvers<void>()
	const host = { close: () => closing.promise }
	await closeOnHotReload(hot, host)
	const disposed = hot.dispose.mock.calls[0]![0]()
	const [event, onReload] = hot.on.mock.calls[0]!
	expect(event).toBe('vite:beforeFullReload')
	const reloaded = onReload()
	const error = new Error('close failed')
	closing.reject(error)
	await expect(disposed).rejects.toBe(error)
	await expect(reloaded).rejects.toBe(error)
})

it('drains virtual reimports in order even when the runner skipped dispose', async () => {
	const data = { host: 'application data' }
	const closing = Promise.withResolvers<void>()
	const first = { close: vi.fn(() => closing.promise) }
	const second = { close: vi.fn(async () => {}) }
	const latest = { close: vi.fn(async () => {}) }
	await closeOnHotReload(context(data), first)
	const adopting = closeOnHotReload(context(data), second)
	const next = closeOnHotReload(context(data), latest)
	expect(first.close).toHaveBeenCalledOnce()
	expect(second.close).not.toHaveBeenCalled()
	closing.resolve()
	await Promise.all([adopting, next])
	expect(second.close).toHaveBeenCalledOnce()
	expect(latest.close).not.toHaveBeenCalled()
	expect(data.host).toBe('application data')
	await closeOnHotReload(context(data), latest)
	expect(latest.close).not.toHaveBeenCalled()
})

it('reports failed retirement, releases the unpublished Host and accepts a later evaluation', async () => {
	const data = {}
	const error = new Error('close failed')
	const failed = {
		close() {
			throw error
		},
	}
	const unpublished = { close: vi.fn(async () => {}) }
	await closeOnHotReload(context(data), failed)
	await expect(closeOnHotReload(context(data), unpublished)).rejects.toBe(error)
	expect(unpublished.close).toHaveBeenCalledOnce()
	await closeOnHotReload(context(data), { close: async () => {} })
})
