import { expectTypeOf, test } from 'vitest'
import { singleflight, type Singleflight } from '@pluxel/async/singleflight'

test('singleflight fixes one key/result domain and accepts sync, async and thenable tasks', () => {
	const flights = singleflight<string, { id: string; count: number }>()
	expectTypeOf(flights).toEqualTypeOf<Singleflight<string, { id: string; count: number }>>()
	expectTypeOf(flights.run('a', () => ({ id: 'a', count: 1 }))).toEqualTypeOf<
		Promise<{ id: string; count: number }>
	>()
	expectTypeOf(flights.run('a', async () => ({ id: 'a', count: 2 }))).toEqualTypeOf<
		Promise<{ id: string; count: number }>
	>()
	expectTypeOf(flights.get('a')).toEqualTypeOf<Promise<{ id: string; count: number }> | undefined>()
	expectTypeOf(flights.size).toEqualTypeOf<number>()
	expectTypeOf(flights.drain()).toEqualTypeOf<Promise<void>>()
	expectTypeOf(flights.close()).toEqualTypeOf<Promise<void>>()
	// @ts-expect-error key must match the fixed domain
	flights.run(1, () => ({ id: 'a', count: 1 }))
	// @ts-expect-error run cannot change the instance's result domain
	flights.run('a', () => 3)
	// @ts-expect-error asynchronous tasks must also match the result domain
	flights.run('a', async () => 'wrong')
	// @ts-expect-error task is mandatory even when a flight may exist
	flights.run('a')
	// @ts-expect-error observation has the same key domain
	flights.get(1)
	// @ts-expect-error size is read-only
	flights.size = 3
	// @ts-expect-error factory no longer binds an operation
	singleflight((key: string) => key)
	const numeric = singleflight<string, number>()
	const thenable: PromiseLike<number> = Promise.resolve(1)
	expectTypeOf(numeric.run('a', () => thenable)).toEqualTypeOf<Promise<number>>()
	const nested = singleflight<string, Promise<number>>()
	expectTypeOf(nested.run('a', () => Promise.resolve(2))).toEqualTypeOf<Promise<number>>()
})
