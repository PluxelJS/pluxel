import { describe, expect, it } from 'vitest'
import { abortableDelay, ExponentialBackoff, SupersedingAbortScope } from '../src/index.ts'

describe('adapter retry timing', () => {
	it('produces capped deterministic exponential delays and resets', () => {
		const backoff = new ExponentialBackoff({
			initialMs: 100,
			maxMs: 250,
			factor: 2,
			jitter: 0,
			random: () => 0,
		})
		expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
			100, 200, 250, 250,
		])
		backoff.reset()
		expect(backoff.next()).toBe(100)
	})

	it('cancels a pending delay through the owning lifecycle signal', async () => {
		const controller = new AbortController()
		const pending = abortableDelay(60_000, controller.signal)
		controller.abort(new Error('stopped'))
		await expect(pending).rejects.toThrow('stopped')
	})

	it('invalidates stale asynchronous generations', () => {
		const scope = new SupersedingAbortScope()
		const first = scope.renew()
		const second = scope.renew()
		expect(first.signal.aborted).toBe(true)
		expect(first.current()).toBe(false)
		expect(() => first.throwIfStale()).toThrow('Superseded')
		expect(second.current()).toBe(true)
		scope.abort()
		expect(second.current()).toBe(false)
	})
})
