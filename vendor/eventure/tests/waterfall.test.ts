import { Eventure } from 'eventure'
import { beforeEach, describe, expect, it } from 'vitest'

import { silentLogger } from './testUtils'

interface NumberPipelineEvents {
	numEvent: (value: number, next: (value: number) => number) => number
}
interface VoidPipelineEvents {
	voidEvent: (text: string, next: (text: string) => void) => void
}

describe('Eventure.waterfall (number pipeline)', () => {
	let emitter: Eventure<NumberPipelineEvents>
	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('runs listeners in order and returns the final value', () => {
		const calls: string[] = []
		emitter.on('numEvent', (v, next) => {
			calls.push('first')
			return next(v + 1)
		})
		emitter.on('numEvent', (v, next) => {
			calls.push('second')
			return next(v * 2)
		})

		const res = emitter.waterfall('numEvent', 5, (v: number) => {
			calls.push('inner')
			return v - 3
		})

		expect(calls).toEqual(['first', 'second', 'inner'])
		expect(res).toEqual({ ok: true, value: 9 }) // (5+1)*2-3 = 9
	})

	it('runs inner only when there are no listeners', () => {
		const calls: string[] = []
		const res = emitter.waterfall('numEvent', 7, (v: number) => {
			calls.push('inner-only')
			return v * 10
		})

		expect(calls).toEqual(['inner-only'])
		expect(res).toEqual({ ok: true, value: 70 })
	})

	it('marks ok=false when a listener interrupts (does not call next)', () => {
		const calls: string[] = []
		emitter.on('numEvent', (v, next) => {
			calls.push('interrupt')
			return v * 3 // 不调用 next
		})

		const res = emitter.waterfall('numEvent', 2, (v: number) => v - 1)
		expect(calls).toEqual(['interrupt'])
		expect(res).toEqual({ ok: false, value: 6 }) // 2*3 = 6
	})

	it('preserves return values through once listeners', () => {
		emitter.once('numEvent', (value, next) => next(value + 2))

		const res = emitter.waterfall('numEvent', 4, (value: number) => value * 3)
		expect(res).toEqual({ ok: true, value: 18 })
		expect(emitter.count('numEvent')).toBe(0)
	})
})

describe('Eventure.waterfall (void pipeline)', () => {
	let emitter: Eventure<VoidPipelineEvents>
	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('runs listeners in order', () => {
		const calls: string[] = []
		emitter.on('voidEvent', (text, next) => {
			calls.push(`L1:${text}`)
			next(text + ':step1')
		})
		emitter.on('voidEvent', (text, next) => {
			calls.push(`L2:${text}`)
			next(text + ':step2')
		})

		const res = emitter.waterfall('voidEvent', 'start')
		expect(calls).toEqual(['L1:start', 'L2:start:step1'])
		expect(res).toEqual({ ok: true, value: undefined })
	})

	it('stops and marks ok=false when interrupted', () => {
		const calls: string[] = []
		emitter.on('voidEvent', (text, next) => {
			calls.push(text)
			// 不调用 next
		})
		emitter.on('voidEvent', (_text, next) => {
			calls.push('should-not')
			next(_text)
		})

		const res = emitter.waterfall('voidEvent', 'X')
		expect(calls).toEqual(['X'])
		expect(res).toEqual({ ok: false, value: undefined })
	})

	it('returns ok=true when there are no listeners', () => {
		const res = emitter.waterfall('voidEvent', 'nothing')
		expect(res).toEqual({ ok: true, value: undefined })
	})
})

describe('runWaterfall implementation details', () => {
	it('supports 5+ args (fallback apply path)', () => {
		type ManyArgsEvents = {
			ev: (
				a: number,
				b: number,
				c: number,
				d: number,
				e: number,
				next: (a: number, b: number, c: number, d: number, e: number) => number,
			) => number
		}
		const emitter = new Eventure<ManyArgsEvents>({ logger: silentLogger })
		emitter.on('ev', (a, b, c, d, e, next) => next(a + 1, b, c, d, e))
		emitter.on('ev', (a, b, c, d, e, next) => next(a, b + 2, c, d, e))

		const res = emitter.waterfall('ev', 1, 2, 3, 4, 5, (a, b, c, d, e) => {
			return a + b + c + d + e
		})
		expect(res).toEqual({ ok: true, value: 1 + 1 + 2 + 2 + 3 + 4 + 5 })
	})
})
