import { expectTypeOf, test } from 'vitest'
import { singleflight, type Singleflight } from '@pluxel/async/singleflight'

test('singleflight infers keys and awaited values from its bound operation', () => {
	const flights = singleflight(async (key: string) => ({ id: key, count: 1 }))
	expectTypeOf(flights).toEqualTypeOf<Singleflight<string, { id: string; count: number }>>()
	expectTypeOf(flights.run('a')).toEqualTypeOf<Promise<{ id: string; count: number }>>()
	expectTypeOf(flights.close()).toEqualTypeOf<Promise<void>>()
	// @ts-expect-error key must match the bound operation
	flights.run(1)
	// @ts-expect-error every run needs a key
	flights.run()
	// @ts-expect-error a run cannot override the bound operation
	flights.run('a', () => 3)
	const synchronous = singleflight((key: number) => key * 2)
	expectTypeOf(synchronous.run(1)).toEqualTypeOf<Promise<number>>()
})
