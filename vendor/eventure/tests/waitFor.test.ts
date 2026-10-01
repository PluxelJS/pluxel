import { Eventure } from 'eventure'
// tests/waitFor.test.ts
import { beforeEach, describe, expect, it } from 'vitest'

import { silentLogger } from './testUtils'

interface Events {
	ready: []
	data: [number]
}

describe('Eventure.waitFor', () => {
	let emitter: Eventure<Events>
	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('resolves with the emitted args', async () => {
		const p = emitter.waitFor('data', { timeout: 1000 })
		emitter.emit('data', 42)
		const args = await p
		expect(args).toEqual([42])
		// resolve 后应自动移除监听器
		expect(emitter.count('data')).toBe(0)
	})

	it('rejects on timeout and removes the listener', async () => {
		const timeoutMs = 10
		const p = emitter.waitFor('ready', { timeout: timeoutMs })
		await expect(p).rejects.toThrow(
			`waitFor 'ready' timeout after ${timeoutMs}ms`,
		)
		expect(emitter.count('ready')).toBe(0)
	})

	it('rejects invalid timeout values before registering', () => {
		expect(() => {
			emitter.waitFor('ready', { timeout: -1 })
		}).toThrow(RangeError)
		expect(() => {
			emitter.waitFor('ready', { timeout: Number.NaN })
		}).toThrow(RangeError)
		expect(() => {
			emitter.waitFor('ready', { timeout: Infinity })
		}).toThrow(RangeError)
		expect(emitter.count('ready')).toBe(0)
	})

	it('supports filter (rejects when no matching emission occurs)', async () => {
		const timeoutMs = 10
		const p = emitter.waitFor('data', {
			timeout: timeoutMs,
			filter: (v) => v > 100, // 永不满足
		})
		emitter.emit('data', 10)
		await expect(p).rejects.toThrow(
			`waitFor 'data' timeout after ${timeoutMs}ms`,
		)
		expect(emitter.count('data')).toBe(0)
	})

	it('supports filter (resolves on the first match)', async () => {
		const p = emitter.waitFor('data', {
			timeout: 1000,
			filter: (v) => v > 10,
		})
		emitter.emit('data', 5) // 不匹配，不会 resolve
		emitter.emit('data', 20) // 第一次匹配
		const args = await p
		expect(args).toEqual([20])
		expect(emitter.count('data')).toBe(0)
	})

	it('rejects and cleans up when filter throws', async () => {
		const p = emitter.waitFor('data', {
			timeout: 1000,
			filter: () => {
				throw new Error('bad filter')
			},
		})

		emitter.emit('data', 1)

		await expect(p).rejects.toThrow('bad filter')
		expect(emitter.count('data')).toBe(0)
	})

	it('supports cancel()', async () => {
		const p = emitter.waitFor('data', { timeout: 1000 })
		// 立即取消
		p.cancel()
		emitter.emit('data', 99)
		await expect(p).rejects.toThrow(`waitFor 'data' cancelled`)
		expect(emitter.count('data')).toBe(0)
	})

	it('does not run filter after cancellation in the same emit snapshot', async () => {
		let filterCalls = 0
		const p = emitter.waitFor('data', {
			timeout: 1000,
			filter: () => {
				filterCalls++
				throw new Error('should not run')
			},
		})
		const offFront = emitter.at('data', 'front').on(() => p.cancel())

		emitter.emit('data', 1)

		await expect(p).rejects.toThrow(`waitFor 'data' cancelled`)
		expect(filterCalls).toBe(0)
		expect(emitter.count('data')).toBe(1)
		offFront()
		expect(emitter.count('data')).toBe(0)
	})

	it('cancel() after resolve is a no-op', async () => {
		const p = emitter.waitFor('data', { timeout: 1000 })
		emitter.emit('data', 2)
		const args = await p
		expect(args).toEqual([2])
		expect(() => p.cancel()).not.toThrow()
	})

	it('does not capture past emissions (only future emits)', async () => {
		// 先触发
		emitter.emit('data', 1)
		const timeoutMs = 10
		const p = emitter.waitFor('data', { timeout: timeoutMs })
		await expect(p).rejects.toThrow(
			`waitFor 'data' timeout after ${timeoutMs}ms`,
		)
	})
})
