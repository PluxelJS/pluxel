import { Eventure, EvtChannel } from 'eventure'
// tests/index.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { silentLogger } from './testUtils'

type Events = {
	syncEvt: [number, string]
	asyncEvt: [string]
}

describe('Eventure core', () => {
	let emitter: Eventure<Events>

	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('emits to listeners in registration order', () => {
		const calls: string[] = []
		emitter.on('syncEvt', (n, s) => calls.push(`A:${n}:${s}`))
		emitter.on('syncEvt', (n, s) => calls.push(`B:${n}:${s}`))

		expect(emitter.emit('syncEvt', 42, 'hello')).toBe(2)
		expect(calls).toEqual(['A:42:hello', 'B:42:hello'])
	})

	it('supports off() by original function reference', () => {
		const calls: number[] = []
		const direct = (n: number, _s: string) => calls.push(n + 1000)
		emitter.on('syncEvt', direct)

		expect(emitter.emit('syncEvt', 1, 'x')).toBe(1)
		expect(emitter.off('syncEvt', direct)).toBe(true)
		expect(emitter.off('syncEvt', direct)).toBe(false)

		expect(emitter.emit('syncEvt', 2, 'x')).toBe(0)
		expect(calls).toEqual([1001])
	})

	it('off() can remove wrapped listeners by original function reference', () => {
		const asyncFn = async (_msg: string) => {
			await Promise.resolve()
			return
		}
		emitter.on('asyncEvt', asyncFn)
		expect(emitter.count('asyncEvt')).toBe(1)

		expect(emitter.off('asyncEvt', asyncFn)).toBe(true)
		expect(emitter.count('asyncEvt')).toBe(0)
	})

	it('returns an unsubscribe function from on()', () => {
		const calls: number[] = []
		const unsub = emitter.on('syncEvt', (n) => calls.push(n))

		emitter.emit('syncEvt', 5, '')
		unsub()
		emitter.emit('syncEvt', 6, '')

		expect(calls).toEqual([5])
	})

	it('does not block sync listeners when an async listener awaits', async () => {
		let asyncSettled = false
		emitter.on('asyncEvt', async () => {
			await Promise.resolve()
			asyncSettled = true
		})

		const syncObserver = vi.fn(() => {
			expect(asyncSettled).toBe(false)
		})
		emitter.on('asyncEvt', syncObserver)

		emitter.emit('asyncEvt', 'test')
		await Promise.resolve()

		expect(syncObserver.mock.calls.length).toBe(1)
		expect(asyncSettled).toBe(true)
	})

	it('warns when maxListeners is exceeded', () => {
		const warn = vi.fn((..._args: unknown[]) => {})
		const local = new Eventure<Pick<Events, 'syncEvt'>>({
			logger: { ...silentLogger, warn },
		})
		local.maxListeners = 1

		local.on('syncEvt', () => {})
		local.on('syncEvt', () => {})

		expect(warn.mock.calls.length).toBe(1)
		expect(String(warn.mock.calls[0]?.[0])).toContain('syncEvt')
	})

	it('supports maxListeners=0 as unlimited and rejects invalid limits', () => {
		const warn = vi.fn((..._args: unknown[]) => {})
		const local = new Eventure<Pick<Events, 'syncEvt'>>({
			logger: { ...silentLogger, warn },
		})
		local.maxListeners = 0

		for (let i = 0; i < 20; i++) {
			local.on('syncEvt', () => {})
		}

		expect(warn.mock.calls.length).toBe(0)
		expect(() => {
			local.maxListeners = -1
		}).toThrow(RangeError)
		expect(() => {
			local.maxListeners = 1.5
		}).toThrow(RangeError)

		local.maxListeners = Infinity
		local.on('syncEvt', () => {})
		expect(warn.mock.calls.length).toBe(0)
	})

	it('captures async errors and forwards them to logger.error', async () => {
		const errorSpy = vi.fn(() => {})
		emitter = new Eventure({ logger: { ...silentLogger, error: errorSpy } })

		expect(() => {
			emitter.on('asyncEvt', async () => {
				await Promise.resolve()
				throw new Error('failure')
			})
			emitter.emit('asyncEvt', 'oops')
		}).not.toThrow()

		// 等待内部 promise 完成（两次微任务以覆盖 async 返回值和 catch）
		await Promise.resolve()
		await Promise.resolve()
		expect(errorSpy.mock.calls.length).toBe(1)
	})

	it('uses captureRejections to control async listener wrapping', () => {
		const asyncListener = async () => {}

		const captured = new Eventure({ logger: silentLogger })
		captured.on('asyncEvt', asyncListener)
		expect(captured.listenersUnsafe('asyncEvt')[0]).not.toBe(asyncListener)

		const raw = new Eventure({
			captureRejections: false,
			logger: silentLogger,
		})
		raw.on('asyncEvt', asyncListener)
		expect(raw.listenersUnsafe('asyncEvt')[0]).toBe(asyncListener)
	})

	it('uses captureReturnedPromises for non-async promise listeners', async () => {
		const errorSpy = vi.fn(() => {})
		emitter = new Eventure({
			captureReturnedPromises: true,
			logger: { ...silentLogger, error: errorSpy },
		})

		const listener = () => Promise.reject(new Error('returned'))
		emitter.on('asyncEvt', listener)
		expect(emitter.listenersUnsafe('asyncEvt')[0]).not.toBe(listener)

		emitter.emit('asyncEvt', 'oops')
		await Promise.resolve()
		await Promise.resolve()
		expect(errorSpy.mock.calls.length).toBe(1)
	})

	it('exposes count(), listeners() and clear()', () => {
		const a = () => {}
		const b = () => {}
		emitter.on('syncEvt', a)
		emitter.on('syncEvt', b)

		expect(emitter.count('syncEvt')).toBe(2)
		expect(emitter.listeners('syncEvt')).toEqual([a, b])

		emitter.clear('syncEvt')
		expect(emitter.count('syncEvt')).toBe(0)
		expect(emitter.listeners('syncEvt')).toEqual([])
	})

	it('keeps core state available to subclasses', () => {
		class InspectableEventure extends Eventure<Events> {
			public rawCount(event: keyof Events) {
				return this._readListeners(event).length
			}
		}
		class InspectableChannel extends EvtChannel<[number]> {
			public rawCount() {
				return this._listeners.length
			}
		}

		const local = new InspectableEventure({ logger: silentLogger })
		local.on('syncEvt', () => {})
		expect(local.rawCount('syncEvt')).toBe(1)

		const channel = new InspectableChannel({ logger: silentLogger })
		channel.on(() => {})
		expect(channel.rawCount()).toBe(1)
	})
})
