import { describe, expect, it, vi } from 'vitest'
import { BatchDebouncer } from '../../src/hmr/engine/internals'

describe('BatchDebouncer waitForIdle', () => {
	it('resolves immediately when idle', async () => {
		const d = new BatchDebouncer(async () => {}, 10, 100, 10)
		await expect(d.waitForIdle({ timeoutMs: 5 })).resolves.toBeUndefined()
	})

	it('resolves after a scheduled flush completes', async () => {
		vi.useFakeTimers()
		try {
			let flushed = 0
			const d = new BatchDebouncer(
				async () => {
					flushed++
				},
				10,
				100,
				10,
			)

			d.push('a')
			const idle = d.waitForIdle({ timeoutMs: 1_000 })

			await vi.advanceTimersByTimeAsync(10)
			await idle
			expect(flushed).toBe(1)
		} finally {
			vi.useRealTimers()
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
})
