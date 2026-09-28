import { expectTypeOf, test } from 'vitest'
import { grfn, type Ref } from '@pluxel/async/grfn'
import { mapConcurrent, SKIP, take, batch, toArray } from '@pluxel/async/iter'

test('named graph inputs and selected outputs infer without callback annotations', () => {
	const g = grfn<{ id: string }>()
	const row = g.task({ input: g.input }, async ({ input }) => ({ id: input.id, count: 1 }))
	const count = g.task({ row }, (dependencies) => dependencies.row.count)
	expectTypeOf(count).toEqualTypeOf<Ref<number>>()
	expectTypeOf(g.compile(count)).toEqualTypeOf<(input: { id: string }) => Promise<number>>()
	expectTypeOf(g.compile({ row, count })).returns.toEqualTypeOf<
		Promise<{
			row: { id: string; count: number }
			count: number
		}>
	>()
	// @ts-expect-error values are not references
	g.task({ count: 1 }, () => 2)
	// @ts-expect-error a resolved number is not a string
	g.task({ count }, (dependencies) => dependencies.count.toUpperCase())
	// @ts-expect-error invocation must supply the declared input
	g.compile(count)()
	// @ts-expect-error 'then' is reserved to avoid Promise assimilation of output records
	// oxlint-disable-next-line unicorn/no-thenable -- The type test verifies that this hazardous key is rejected.
	g.compile({ then: count })
})

test('iteration resolves inputs, excludes SKIP, and preserves helper output types', () => {
	const values = mapConcurrent(
		[Promise.resolve(1)],
		async (n, { index, signal }) => {
			expectTypeOf(n).toEqualTypeOf<number>()
			expectTypeOf(index).toEqualTypeOf<number>()
			expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
			return n ? `${n}` : SKIP
		},
		{ concurrency: 2 },
	)
	expectTypeOf(values).toEqualTypeOf<AsyncIterable<string>>()
	expectTypeOf(take(values, 1)).toEqualTypeOf<AsyncIterable<string>>()
	expectTypeOf(batch(values, 2)).toEqualTypeOf<AsyncIterable<string[]>>()
	expectTypeOf(toArray(values)).toEqualTypeOf<Promise<string[]>>()
	// @ts-expect-error concurrency is intentionally explicit, not unlimited by default
	mapConcurrent([1], (n) => n, {})
	// @ts-expect-error output order is a closed union, not a second scheduling API
	mapConcurrent([1], (n) => n, { concurrency: 1, order: 'parallel' })
})

test('consumers preserve awaited element and accumulator types', async () => {
	const { forEach, find, some, every, reduce } = await import('@pluxel/async/iter')
	const values = [Promise.resolve(1)]
	expectTypeOf(
		forEach(values, (value, index) => {
			expectTypeOf(value).toEqualTypeOf<number>()
			expectTypeOf(index).toEqualTypeOf<number>()
		}),
	).toEqualTypeOf<Promise<void>>()
	expectTypeOf(find(values, (value) => value > 0)).toEqualTypeOf<Promise<number | undefined>>()
	expectTypeOf(some([undefined], () => true)).toEqualTypeOf<Promise<boolean>>()
	expectTypeOf(every(values, () => true)).toEqualTypeOf<Promise<boolean>>()
	expectTypeOf(reduce(values, async (text, value) => text + value, '')).toEqualTypeOf<
		Promise<string>
	>()
	expectTypeOf(
		reduce(
			values,
			(sum, value) => {
				expectTypeOf(sum).toEqualTypeOf<number>()
				return sum + value
			},
			Promise.resolve(0),
		),
	).toEqualTypeOf<Promise<number>>()
	// @ts-expect-error accumulator type comes from the initial value and reducer
	reduce(values, () => 3, '')
	// @ts-expect-error explicit initial value required, including for empty sources
	reduce(values, (a: number, b) => a + b)
})

test('retry and waits infer ordinary Promise results and require explicit policy', async () => {
	const { retry } = await import('@pluxel/async/retry')
	const { sleep, waitFor, until } = await import('@pluxel/async/wait')
	expectTypeOf(
		retry(
			async ({ attempt, signal }) => {
				expectTypeOf(attempt).toEqualTypeOf<number>()
				expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
				return 'value'
			},
			{
				attempts: 2,
				shouldRetry: (error) => {
					expectTypeOf(error).toEqualTypeOf<unknown>()
					return false
				},
			},
		),
	).toEqualTypeOf<Promise<string>>()
	expectTypeOf(waitFor(Promise.resolve(1))).toEqualTypeOf<Promise<number>>()
	expectTypeOf(sleep(1)).toEqualTypeOf<Promise<void>>()
	expectTypeOf(until(() => true, { intervalMs: 1 })).toEqualTypeOf<Promise<void>>()
	// @ts-expect-error retry authorization is required
	retry(() => 1, { attempts: 2 })
	// @ts-expect-error polling interval is explicit
	until(() => true, {})
})
