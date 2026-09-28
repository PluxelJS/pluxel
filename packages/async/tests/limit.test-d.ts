import { expectTypeOf, test } from 'vitest'
import { keyedLimit, limit } from '@pluxel/async/limit'

test('limiter infers sync, async and thenable results and contextual signal', () => {
	const queue = limit({ concurrency: 2 })
	expectTypeOf(queue.run(() => 1)).toEqualTypeOf<Promise<number>>()
	expectTypeOf(
		queue.run(async ({ signal }) => {
			expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
			return 'value'
		}),
	).toEqualTypeOf<Promise<string>>()
	const thenable: PromiseLike<boolean> = Promise.resolve(true)
	expectTypeOf(queue.run(() => thenable)).toEqualTypeOf<Promise<boolean>>()
	expectTypeOf(queue.close()).toEqualTypeOf<Promise<void>>()
	const keyed = keyedLimit<string>({ concurrency: 1 })
	expectTypeOf(keyed.run('file', () => ({ saved: true }))).toEqualTypeOf<
		Promise<{ saved: boolean }>
	>()
	// @ts-expect-error keys use the declared domain
	keyed.run(42, () => 0)
	// @ts-expect-error lazy work is required for admission control
	queue.run(Promise.resolve(1))
})
