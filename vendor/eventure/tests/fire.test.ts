import { Eventure } from 'eventure'
// tests/fire.test.ts
import { beforeEach, describe, expect, it } from 'vitest'

import { silentLogger } from './testUtils'

export interface Events {
	ev: [string]
}

describe('Eventure.fire (sync generator)', () => {
	let emitter: Eventure<Events>
	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('yields success/error records for sync listeners', () => {
		const okFn = (s: string) => s + '!'
		const errFn = (s: string) => {
			throw new Error('fail')
		}

		emitter.on('ev', okFn)
		emitter.on('ev', errFn)

		const gen = emitter.fire('ev', 'hi')
		const results = Array.from(gen)

		expect(results).toHaveLength(2)

		// 第一个 listener 成功
		expect(results[0]).toMatchObject({
			type: 'success',
			result: 'hi!',
		})

		expect(results[0]?.fn).toBe(okFn)

		// 第二个 listener 抛错
		const second = results[1]
		expect(second?.type).toBe('error')
		if (!second || second.type !== 'error')
			throw new Error('Expected error record')
		expect(second.fn).toBe(errFn)
		expect(second.error).toBeInstanceOf(Error)
		expect((second.error as Error).message).toBe('fail')
	})

	it('yields async records for native async listeners', async () => {
		const asyncFn = async (s: string) => s.toUpperCase()
		emitter.on('ev', asyncFn)

		const gen = emitter.fire('ev', 'ok')
		const rec = gen.next().value
		if (!rec) throw new Error('Expected a record')

		expect(rec.type).toBe('async')
		expect(rec.fn).toBe(asyncFn)
		await expect(rec.promise).resolves.toBe('OK')
	})

	it('exposes async throw as a rejected async record promise', async () => {
		const boomFn = async (s: string) => {
			throw new Error('boom')
		}
		emitter.on('ev', boomFn)

		const gen = emitter.fire('ev', 'x')
		const rec = gen.next().value
		if (!rec) throw new Error('Expected a record')

		expect(rec.type).toBe('async')
		await expect(rec.promise).rejects.toThrow('boom')
	})

	it('treats promise-returning listeners as async records', async () => {
		const promiseFn = (s: string) => Promise.resolve().then(() => `${s}!`)
		emitter.on('ev', promiseFn)

		const rec = emitter.fire('ev', 'yo').next().value
		if (!rec) throw new Error('Expected a record')
		expect(rec.type).toBe('async')
		await expect(rec.promise).resolves.toBe('yo!')
	})

	it('exposes promise rejection via the async record promise', async () => {
		const promiseFn = (s: string) =>
			Promise.resolve().then(() => {
				throw new Error(`bad:${s}`)
			})
		emitter.on('ev', promiseFn)

		const rec = emitter.fire('ev', 'err').next().value
		if (!rec) throw new Error('Expected a record')
		expect(rec.type).toBe('async')
		await expect(rec.promise).rejects.toThrow('bad:err')
	})
})

describe('Eventure.fireAsync (AsyncGenerator)', () => {
	let emitter: Eventure<Events>
	beforeEach(() => {
		emitter = new Eventure({ logger: silentLogger })
	})

	it('awaits each listener and yields success/error records', async () => {
		const syncFn = (s: string) => s + '?'
		const throwFn = (s: string) => {
			throw new Error('oops')
		}
		const asyncOk = async (s: string) => s.repeat(2)
		const asyncErr = async (s: string) => new Error('bad result')
		const asyncThrow = async () => {
			throw new Error('bad throw')
		}

		emitter.on('ev', syncFn)
		emitter.on('ev', throwFn)
		emitter.on('ev', asyncOk)
		emitter.on('ev', asyncErr)
		emitter.on('ev', asyncThrow)

		const results: any[] = []
		for await (const r of emitter.fireAsync('ev', 'a')) {
			results.push(r)
		}

		expect(results).toHaveLength(5)

		// sync 成功
		expect(results[0]).toEqual({
			type: 'success',
			fn: syncFn,
			result: 'a?',
		})

		// sync 抛错
		expect(results[1].type).toBe('error')
		expect(results[1].fn).toBe(throwFn)
		expect(results[1].error).toBeInstanceOf(Error)
		expect((results[1].error as Error).message).toBe('oops')

		expect(results[2].type).toBe('success')
		expect(results[2].fn).toBe(asyncOk)
		expect(results[2].result).toBe('aa')

		expect(results[3].type).toBe('success')
		expect(results[3].fn).toBe(asyncErr)
		expect(results[3].result).toBeInstanceOf(Error)
		expect((results[3].result as Error).message).toBe('bad result')

		expect(results[4].type).toBe('error')
		expect(results[4].fn).toBe(asyncThrow)
		expect(results[4].error).toBeInstanceOf(Error)
		expect((results[4].error as Error).message).toBe('bad throw')
	})

	it('supports early termination (return/break) without invoking later listeners', async () => {
		let count = 0
		emitter.on('ev', () => {
			count++
			return 'x'
		})
		emitter.on('ev', () => {
			count++
			throw new Error('stop')
		})
		emitter.on('ev', () => {
			count++
			return 'y'
		})

		const iter = emitter.fireAsync('ev', '')
		const first = await iter.next()
		expect(first.value.type).toBe('success')
		const second = await iter.next()
		expect(second.value.type).toBe('error')

		// 提前终止
		await iter.return?.(undefined)
		expect(count).toBe(2)
	})

	it('turns promise rejection into an error record', async () => {
		const promiseFn = (_s: string) =>
			Promise.resolve().then(() => {
				throw new Error('reject:' + _s)
			})
		emitter.on('ev', promiseFn)

		const iter = emitter.fireAsync('ev', 'NOPE')
		const first = await iter.next()
		expect(first.value.type).toBe('error')
		expect(first.value.error).toBeInstanceOf(Error)
		expect((first.value.error as Error).message).toBe('reject:NOPE')
	})
})
