import { describe, expect, it, vi } from 'vitest'
import { BatchDebouncer } from '../../src/hmr/engine/internals'

describe('BatchDebouncer waitForIdle', () => {
	it('captures observed changes without waiting for later batches or their debounce window', async () => {
		const active = Promise.withResolvers<void>()
		const later = Promise.withResolvers<void>()
		const started = Promise.withResolvers<void>()
		const flushed: string[][] = []
		const d = new BatchDebouncer(
			async (files) => {
				flushed.push(files)
				if (files.includes('observed')) {
					started.resolve()
					await active.promise
				} else await later.promise
			},
			60_000,
			60_000,
			10,
		)
		try {
			d.push('observed')
			const barrier = d.flushObserved()
			await started.promise
			d.push('later')
			const next = d.flushObserved()
			active.resolve()
			await barrier
			expect(d.isIdle()).toBe(false)
			later.resolve()
			await next
			expect(flushed).toEqual([['observed'], ['later']])
		} finally {
			active.resolve()
			later.resolve()
			await d.close()
		}
	})

	it('rejects with a timeout error when inFlight never settles', async () => {
		vi.useFakeTimers()
		try {
			const d = new BatchDebouncer(
				async () => {
					// never resolve
					await new Promise<void>(() => {})
				},
				10,
				100,
				10,
			)

			d.push('a')
			const p = d.waitForIdle({ timeoutMs: 50 })
			const assertion = p.catch((error: unknown) => error)

			await vi.advanceTimersByTimeAsync(10) // schedule flush
			await vi.advanceTimersByTimeAsync(50) // idle timeout

			await expect(assertion).resolves.toMatchObject({ name: 'HmrIdleTimeoutError' })
		} finally {
			vi.useRealTimers()
		}
	})

	it('drops queued work, drains the active flush, and stops admission when closed', async () => {
		vi.useFakeTimers()
		try {
			let release: (() => void) | undefined
			const flushed: string[][] = []
			const d = new BatchDebouncer(
				async (files) => {
					flushed.push(files)
					await new Promise<void>((resolve) => {
						release = resolve
					})
				},
				10,
				100,
				10,
			)

			d.push('active')
			await vi.advanceTimersByTimeAsync(10)
			d.push('queued')
			const closed = d.close()
			let settled = false
			void closed.then(() => {
				settled = true
				return undefined
			})
			await Promise.resolve()
			expect(settled).toBe(false)

			release?.()
			await closed
			d.push('after-close')
			await vi.advanceTimersByTimeAsync(200)

			expect(flushed).toEqual([['active']])
			expect(d.isIdle()).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it('discards a serialized flush that has not started when close begins', async () => {
		let releaseActive: (() => void) | undefined
		let markActiveStarted: (() => void) | undefined
		const activeStarted = new Promise<void>((resolve) => {
			markActiveStarted = resolve
		})
		const flushed: string[][] = []
		const d = new BatchDebouncer(
			async (files) => {
				flushed.push(files)
				if (files[0] !== 'active') return
				markActiveStarted?.()
				await new Promise<void>((resolve) => {
					releaseActive = resolve
				})
			},
			10,
			100,
			1,
		)

		d.push('active')
		await activeStarted
		d.push('not-started')
		const closed = d.close()
		releaseActive?.()
		await closed

		expect(flushed).toEqual([['active']])
		expect(d.isIdle()).toBe(true)
	})
})
