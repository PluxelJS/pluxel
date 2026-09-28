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
