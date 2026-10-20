import { afterEach, expect, it, vi } from 'vitest'
import { createHostViteDriver, type HostViteBatch } from '../src/driver'

const signal = () => new AbortController().signal
const change = (file: string) => ({ file, type: 'update' as const, kind: 'source' as const })
afterEach(() => vi.useRealTimers())

it('coalesces repeated saves and sources/artifacts into one automatic batch', async () => {
	vi.useFakeTimers()
	const apply = vi.fn(async (_batch: HostViteBatch) => {})
	const driver = createHostViteDriver({ apply, onError: vi.fn() })
	for (let i = 0; i < 1000; i++) driver.changed(change(`/file-${i % 8}.ts`))
	driver.changed({ file: '/view.tsx', type: 'create', kind: 'artifact' })
	driver.changed({ file: '/view.tsx', type: 'update', kind: 'source' })
	await vi.runAllTimersAsync()
	expect(apply).toHaveBeenCalledTimes(1)
	expect(apply.mock.calls[0]![0].changes).toHaveLength(9)
	expect(apply.mock.calls[0]![0].changes.at(-1)).toEqual({
		file: '/view.tsx',
		type: 'create',
		kind: 'source',
	})
	expect(driver.status()).toMatchObject({ running: false, pending: { files: 0, full: false } })
	await driver.close()
})

it('pause retains bounded changes without executing, apply remains paused and empty apply is a no-op', async () => {
	vi.useFakeTimers()
	const apply = vi.fn(async (_batch: HostViteBatch) => {})
	const driver = createHostViteDriver({ apply, onError: vi.fn() })
	driver.changed(change('/first'))
	await driver.control('pause', signal())
	for (let i = 0; i < 10_000; i++) driver.changed(change(`/file-${i}`))
	await vi.runAllTimersAsync()
	expect(apply).not.toHaveBeenCalled()
	expect(driver.status()).toMatchObject({ mode: 'paused', pending: { files: 0, full: true } })
	expect(() => driver.assertApplied()).toThrow(expect.objectContaining({ code: 'hmr_pending' }))
	await driver.control('apply', signal())
	expect(apply).toHaveBeenCalledExactlyOnceWith({ changes: [], full: true })
	await driver.control('apply', signal())
	expect(apply).toHaveBeenCalledTimes(1)
	expect(driver.status().mode).toBe('paused')
	await driver.close()
})

it('keeps edits observed during apply for the next batch and pause waits only active work', async () => {
	const held = Promise.withResolvers<void>()
	const entered = Promise.withResolvers<void>()
	const apply = vi.fn(async () => {
		entered.resolve()
		await held.promise
	})
	const driver = createHostViteDriver({ apply, onError: vi.fn() })
	driver.changed(change('/first'))
	const applying = driver.control('apply', signal())
	await entered.promise
	driver.changed(change('/next'))
	const paused = driver.control('pause', signal())
	held.resolve()
	await Promise.all([applying, paused])
	expect(apply).toHaveBeenCalledTimes(1)
	expect(driver.status()).toMatchObject({ mode: 'paused', running: false, pending: { files: 1 } })
	await driver.control('apply', signal())
	expect(apply).toHaveBeenCalledTimes(2)
	await driver.close()
})

it('retains a failed batch without automatic retry, then merges new evidence and recovers', async () => {
	vi.useFakeTimers()
	const error = new Error('bad source')
	const apply = vi.fn(async (_batch: HostViteBatch) => {}).mockRejectedValueOnce(error)
	const onError = vi.fn()
	const driver = createHostViteDriver({ apply, onError })
	driver.changed(change('/broken'))
	await vi.runAllTimersAsync()
	await driver.settled()
	await vi.advanceTimersByTimeAsync(1000)
	expect(apply).toHaveBeenCalledTimes(1)
	expect(onError).toHaveBeenCalledExactlyOnceWith(error)
	expect(() => driver.assertApplied()).toThrow(expect.objectContaining({ code: 'hmr_pending' }))
	driver.changed(change('/repair'))
	await vi.runAllTimersAsync()
	expect(apply).toHaveBeenCalledTimes(2)
	expect(new Set(apply.mock.calls[1]![0].changes.map(({ file }) => file))).toEqual(
		new Set(['/broken', '/repair']),
	)
	expect(() => driver.assertApplied()).not.toThrow()
	await driver.close()
})

it('does not overwrite a newer removal when restoring a failed in-flight batch', async () => {
	const held = Promise.withResolvers<void>()
	const entered = Promise.withResolvers<void>()
	const apply = vi.fn(async (_batch: HostViteBatch) => {})
	apply.mockImplementationOnce(async () => {
		entered.resolve()
		await held.promise
	})
	const driver = createHostViteDriver({ apply, onError: vi.fn() })
	driver.changed({ file: '/new', type: 'create', kind: 'source' })
	const applying = driver.control('apply', signal())
	const failed = applying.catch((error: unknown) => error)
	await entered.promise
	driver.changed({ file: '/new', type: 'delete', kind: 'source' })
	held.reject(new Error('failure'))
	expect(await failed).toMatchObject({ message: 'failure' })
	await driver.control('apply', signal())
	expect(apply.mock.calls[1]![0].changes).toEqual([
		{ file: '/new', type: 'delete', kind: 'source' },
	])
	await driver.close()
})

it('resume applies pending once then admits automatic updates; cancellation does not roll back', async () => {
	vi.useFakeTimers()
	const apply = vi.fn(async () => {})
	const driver = createHostViteDriver({ apply, onError: vi.fn() })
	await driver.control('pause', signal())
	driver.changed(change('/one'))
	await driver.control('resume', signal())
	expect(driver.status().mode).toBe('auto')
	driver.changed(change('/two'))
	await vi.runAllTimersAsync()
	expect(apply).toHaveBeenCalledTimes(2)
	const cancelled = new AbortController()
	cancelled.abort(new Error('cancelled'))
	await expect(driver.control('pause', cancelled.signal)).rejects.toThrow('cancelled')
	expect(driver.status().mode).toBe('auto')
	await driver.close()
})

it('close discards unstarted edits and drains active execution without a later batch', async () => {
	vi.useFakeTimers()
	const held = Promise.withResolvers<void>()
	const entered = Promise.withResolvers<void>()
	const apply = vi.fn(async () => {
		entered.resolve()
		await held.promise
	})
	const driver = createHostViteDriver({ apply, onError: vi.fn() })
	driver.changed(change('/first'))
	const applying = driver.control('apply', signal())
	await entered.promise
	driver.changed(change('/pending'))
	const closed = driver.close()
	held.resolve()
	await Promise.all([closed, applying])
	await vi.runAllTimersAsync()
	expect(apply).toHaveBeenCalledTimes(1)
	expect(driver.status().pending).toEqual({ files: 0, full: false })
	await expect(driver.control('apply', signal())).rejects.toMatchObject({
		code: 'host_development_closed',
	})
})
