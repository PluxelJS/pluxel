import { Eventure, EvtChannel, type SubscriptionOptions } from 'eventure'
import { beforeEach, describe, expect, it } from 'vitest'

import { silentLogger } from './testUtils'

type StringEventMap = { ev: [string] }
type ChannelEvent = [string]

type Harness = {
	name: string
	create: () => {
		on: (
			listener: (value: string) => unknown,
			options?: SubscriptionOptions,
		) => () => void
		at: (
			position:
				| 'front'
				| 'back'
				| number
				| ((ctx: { count: number }) => number),
		) => {
			on: (
				listener: (value: string) => unknown,
				options?: SubscriptionOptions,
			) => () => void
		}
		emit: (value: string) => number
		count: () => number
	}
}

const harnesses: Harness[] = [
	{
		name: 'Eventure',
		create: () => {
			const emitter = new Eventure<StringEventMap>({ logger: silentLogger })
			return {
				on: (listener, options) => emitter.on('ev', listener, options),
				at: (position) => emitter.at('ev', position as any),
				emit: (value) => emitter.emit('ev', value),
				count: () => emitter.count('ev'),
			}
		},
	},
	{
		name: 'EvtChannel',
		create: () => {
			const channel = new EvtChannel<ChannelEvent>({ logger: silentLogger })
			return {
				on: (listener, options) => channel.on(listener, options),
				at: (position) => channel.at(position),
				emit: (value) => channel.emit(value),
				count: () => channel.count(),
			}
		},
	},
]

describe.each(harnesses)('at scope ($name)', ({ create }) => {
	let h: ReturnType<Harness['create']>

	beforeEach(() => {
		h = create()
	})

	it('inserts at specific index with clamping', () => {
		const calls: string[] = []
		h.on((v) => calls.push(`B:${v}`))
		h.on((v) => calls.push(`C:${v}`))
		h.at(-100).on((v) => calls.push(`A:${v}`))
		h.at(999).on((v) => calls.push(`D:${v}`))

		expect(h.emit('x')).toBe(4)
		expect(calls).toEqual(['A:x', 'B:x', 'C:x', 'D:x'])
	})

	it('supports front/back and resolver positions', () => {
		const calls: string[] = []
		h.on((v) => calls.push(`B:${v}`))
		h.at('front').on((v) => calls.push(`A:${v}`))
		h.at('back').on((v) => calls.push(`D:${v}`))
		h.at(({ count }) => Math.floor(count / 2)).on((v) => calls.push(`C:${v}`))

		expect(h.emit('x')).toBe(4)
		expect(calls).toEqual(['A:x', 'C:x', 'B:x', 'D:x'])
	})

	it('supports AbortSignal', () => {
		const controller = new AbortController()
		const calls: string[] = []

		h.at('front').on((v) => calls.push(v), { signal: controller.signal })
		expect(h.count()).toBe(1)
		controller.abort()
		expect(h.count()).toBe(0)
		expect(h.emit('x')).toBe(0)
		expect(calls).toEqual([])
	})
})

describe('Eventure listenersUnsafe alias', () => {
	let emitter: Eventure<StringEventMap>

	beforeEach(() => {
		emitter = new Eventure<StringEventMap>({ logger: silentLogger })
	})

	it('queryListeners returns the same reference as listenersUnsafe', () => {
		emitter.on('ev', () => {})
		const a = emitter.listenersUnsafe('ev')
		const b = emitter.queryListeners('ev')
		expect(a).toBe(b)
	})

	it('mutating listenersUnsafe affects subsequent emits (unsafe by design)', () => {
		const calls: string[] = []

		emitter.on('ev', (v) => calls.push(`A:${v}`))
		const internal = emitter.listenersUnsafe('ev')
		internal.push((v) => calls.push(`B:${v}`))

		expect(emitter.emit('ev', 'x')).toBe(2)
		expect(calls).toEqual(['A:x', 'B:x'])
	})
})
