import { describe, expect, it } from 'vitest'
import { LoginFailureLimiter } from '../src/login-failures.ts'

describe('local login failure admission', () => {
	it('blocks the fifth failed identity for a fixed window and clears on success', () => {
		const limiter = new LoginFailureLimiter()
		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(limiter.allows('admin', 10)).toBe(true)
			limiter.recordFailure('admin', 10)
		}
		expect(limiter.allows('admin', 10)).toBe(true)
		limiter.recordFailure('admin', 10)
		expect(limiter.allows('admin', 10)).toBe(false)

		limiter.clear('admin')
		expect(limiter.allows('admin', 11)).toBe(true)
	})

	it('expires failures and bounds attacker-controlled identity state', () => {
		const limiter = new LoginFailureLimiter()
		limiter.recordFailure('admin', 0)
		expect(limiter.allows('admin', 5 * 60_000)).toBe(true)

		for (let index = 0; index < 1_100; index += 1) {
			limiter.recordFailure(`user-${index}`, 5 * 60_000)
		}
		expect(limiter.size).toBe(1_024)
		expect(limiter.allows('user-0', 5 * 60_000)).toBe(true)
	})
})
