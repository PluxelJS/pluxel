import { describe, expect, it } from 'vitest'
import { RetryGate } from '../src/retry-gate.ts'

describe('RetryGate', () => {
	it('waits for the longest active server-directed interval', async () => {
		let now = 1_000
		const delays: number[] = []
		const gate = new RetryGate({
			now: () => now,
			delay: async (ms) => {
				delays.push(ms)
				now += ms
			},
		})
		gate.blockFor(100)
		gate.blockFor(250)
		gate.blockFor(50)
		await gate.wait()
		expect(delays).toEqual([250])
	})

	it('cancels a blocked wait without replaying work', async () => {
		const gate = new RetryGate()
		const controller = new AbortController()
		gate.blockFor(60_000)
		const pending = gate.wait(controller.signal)
		controller.abort(new Error('stopped'))
		await expect(pending).rejects.toThrow('stopped')
	})
})
