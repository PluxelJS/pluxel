import { describe, expect, it } from 'vitest'
import { FontTaskScheduler } from '../src/font-task-scheduler.ts'

describe('FontTaskScheduler', () => {
	it('bounds per-owner queues and dispatches waiting owners round-robin', async () => {
		const scheduler = new FontTaskScheduler(1, 3, 2)
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
		).rejects.toMatchObject({ code: 'FONT_BUSY' })
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

	it('bounds the aggregate queue and rejects queued work when closed', async () => {
		const scheduler = new FontTaskScheduler(1, 1, 1)
		const firstOwner = scheduler.createOwner()
		const secondOwner = scheduler.createOwner()
		const firstGate = deferred<void>()
		const first = scheduler.run(firstOwner, new AbortController().signal, async () => {
			await firstGate.promise
		})
		const queued = scheduler.run(
			firstOwner,
			new AbortController().signal,
			async (): Promise<void> => {},
		)
		await expect(
			scheduler.run(secondOwner, new AbortController().signal, async (): Promise<void> => {}),
		).rejects.toMatchObject({ code: 'FONT_BUSY' })

		const close = scheduler.close(new Error('scheduler stopped'))
		let closed = false
		void close.then((): undefined => {
			closed = true
			return undefined
		})
		await expect(queued).rejects.toThrow('scheduler stopped')
		await Promise.resolve()
		expect(closed).toBe(false)

		firstGate.resolve()
		await first
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
