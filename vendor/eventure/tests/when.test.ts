import { Eventure } from 'eventure'
// tests/when.test.ts
import { beforeEach, describe, expect, it } from 'vitest'

import { silentLogger } from './testUtils'

interface Events {
	num: [number]
	str: [string]
}

describe('Eventure when()', () => {
	let emitter: Eventure<Events>
	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('once() only fires when predicate matches (and auto-unsubscribes)', () => {
		const calls: number[] = []

		// 只在数字为偶数时触发一次
		emitter.when('num', (n) => n % 2 === 0).once((n) => calls.push(n))

		emitter.emit('num', 1)
		emitter.emit('num', 3)
		expect(calls).toEqual([]) // predicate 均为 false

		emitter.emit('num', 4)
		expect(calls).toEqual([4]) // 第一次 predicate 为 true

		emitter.emit('num', 6)
		expect(calls).toEqual([4]) // 已自动退订，不再触发
	})

	it('at(front).when().once() respects prepend order and predicate', () => {
		const calls: string[] = []

		emitter.on('str', (s) => calls.push(`on:${s}`))

		// 只在字符串长度大于 3 时，优先触发一次
		emitter
			.at('str', 'front')
			.when((s) => s.length > 3)
			.once((s) => calls.push(`first:${s}`))

		emitter.emit('str', 'hi')
		expect(calls).toEqual(['on:hi']) // predicate false

		emitter.emit('str', 'hello')
		// at(front) 先执行，然后普通 listener
		expect(calls).toEqual(['on:hi', 'first:hello', 'on:hello'])

		calls.length = 0
		emitter.emit('str', 'world')
		expect(calls).toEqual(['on:world']) // 仅剩普通 listener
	})

	it('many() counts only predicate=true emissions', () => {
		const calls: number[] = []

		// 只在正数时，连续触发三次后退订
		emitter.when('num', (n) => n > 0).many(3, (n) => calls.push(n))

		// 若 predicate=false，不计数也不触发
		emitter.emit('num', -1)
		emitter.emit('num', 0)
		expect(calls).toEqual([])

		emitter.emit('num', 1) // count=1
		emitter.emit('num', 2) // count=2
		emitter.emit('num', 3) // count=3 -> 自动退订
		expect(calls).toEqual([1, 2, 3])

		emitter.emit('num', 4)
		expect(calls).toEqual([1, 2, 3]) // 不再触发
	})

	it('at(front).many() respects prepend order and limit', () => {
		const calls: string[] = []

		emitter.on('str', (s) => calls.push(`on:${s}`))

		// 任意字符串，前两次 at(front).many 优先触发
		emitter.at('str', 'front').many(2, (s) => calls.push(`first:${s}`))

		emitter.emit('str', 'a')
		expect(calls).toEqual(['first:a', 'on:a'])

		calls.length = 0
		emitter.emit('str', 'b')
		expect(calls).toEqual(['first:b', 'on:b'])

		calls.length = 0
		emitter.emit('str', 'c')
		// 前两次已用完，只有普通 listener
		expect(calls).toEqual(['on:c'])
	})

	it('at().once() can be used when no predicate is needed', () => {
		const calls: number[] = []

		emitter.at('num', 'back').once((n) => calls.push(n))

		emitter.emit('num', 7)
		emitter.emit('num', 8)
		expect(calls).toEqual([7])
	})

	it('supports multiple independent when() chains', () => {
		const evens: number[] = []
		const odds: number[] = []

		emitter.when('num', (n) => n % 2 === 0).many(2, (n) => evens.push(n))

		emitter.when('num', (n) => n % 2 === 1).once((n) => odds.push(n))

		// mixed sequence
		;[1, 2, 3, 4, 5].forEach((n) => emitter.emit('num', n))

		expect(evens).toEqual([2, 4]) // 2 次偶数
		expect(odds).toEqual([1]) // 1 次奇数 then auto-unsub
	})
})
