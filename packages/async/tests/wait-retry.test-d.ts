import { expectTypeOf, test } from 'vitest'
import { retry } from '@pluxel/async/retry'
import { waitFor } from '@pluxel/async/wait'

test('waitFor and retry recursively assimilate nested thenable result types', () => {
	const nested = null as unknown as PromiseLike<PromiseLike<{ count: number }>>
	expectTypeOf(waitFor(nested)).toEqualTypeOf<Promise<{ count: number }>>()
	expectTypeOf(waitFor(nested, { signal: new AbortController().signal })).toEqualTypeOf<
		Promise<{ count: number }>
	>()
	expectTypeOf(retry(() => nested, { attempts: 1, shouldRetry: () => false })).toEqualTypeOf<
		Promise<{ count: number }>
	>()
	const mixed = (): number | Promise<string> => (Math.random() < 0.5 ? 1 : Promise.resolve('text'))
	expectTypeOf(retry(mixed, { attempts: 1, shouldRetry: () => false })).toEqualTypeOf<
		Promise<number | string>
	>()
})
