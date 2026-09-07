import { describe, expect, it } from 'vitest'
import { DecodeScheduler } from '../src/decode-scheduler.ts'

describe('DecodeScheduler', () => {
	it('bounds queues per owner and dispatches waiting owners round-robin', async () => {
		const scheduler = new DecodeScheduler(1, 3, 2)
		const firstOwner = scheduler.createOwner()
		const secondOwner = scheduler.createOwner()
		const order: string[] = []
		const firstGate = deferred<void>()
		const first = scheduler.run(firstOwner, new AbortController().signal, async () => {
			order.push('first')
			await firstGate.promise
			return 'first'
		})
		const second = scheduler.run(firstOwner, new AbortController().signal, async () => {
			order.push('second')
			return 'second'
		})
		const third = scheduler.run(firstOwner, new AbortController().signal, async () => {
			order.push('third')
			return 'third'
		})
		await expect(
			scheduler.run(firstOwner, new AbortController().signal, async () => 'overflow'),
		).rejects.toMatchObject({ code: 'DECODE_BUSY' })
		const other = scheduler.run(secondOwner, new AbortController().signal, async () => {
			order.push('other')
			return 'other'
		})

		await Promise.resolve()
		firstGate.resolve()
		await expect(Promise.all([first, second, third, other])).resolves.toEqual([
			'first',
			'second',
			'third',
			'other',
		])
		expect(order).toEqual(['first', 'second', 'other', 'third'])
		await scheduler.close(new Error('test complete'))
	})

	it('keeps an aborted native decode slot until held work actually settles', async () => {
		const scheduler = new DecodeScheduler(1, 1, 1)
		const owner = scheduler.createOwner()
		const controller = new AbortController()
		const nativeGate = deferred<void>()
		const entered = deferred<void>()
		let secondStarted = false
		const first = scheduler.run(owner, controller.signal, async (hold) => {
			hold(nativeGate.promise)
			entered.resolve()
			await abortableWait(nativeGate.promise, controller.signal)
		})
		await entered.promise
		const second = scheduler.run(owner, new AbortController().signal, async () => {
			secondStarted = true
		})

		controller.abort(new Error('caller stopped waiting'))
		await expect(first).rejects.toThrow('caller stopped waiting')
		await Promise.resolve()
		expect(secondStarted).toBe(false)

		nativeGate.resolve()
		await second
		expect(secondStarted).toBe(true)
		await scheduler.close(new Error('test complete'))
	})

	it('rejects queued work and waits for held native completion when closed', async () => {
		const scheduler = new DecodeScheduler(1, 1, 1)
		const owner = scheduler.createOwner()
		const nativeGate = deferred<void>()
		const entered = deferred<void>()
		const first = scheduler.run(owner, new AbortController().signal, async (hold) => {
			hold(nativeGate.promise)
			entered.resolve()
		})
		await entered.promise
		await first
		const queued = scheduler.run(owner, new AbortController().signal, async (): Promise<void> => {})
		const close = scheduler.close(new Error('scheduler stopped'))
		let closed = false
		void close.then((): undefined => {
			closed = true
			return undefined
		})

		await expect(queued).rejects.toThrow('scheduler stopped')
		await Promise.resolve()
		expect(closed).toBe(false)
		nativeGate.resolve()
		await close
		expect(closed).toBe(true)
	})
})

function deferred<T>(): Readonly<{
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
}> {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true })
		}),
	])
}
