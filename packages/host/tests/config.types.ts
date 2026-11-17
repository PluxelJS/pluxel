import * as v from 'valibot'
import { expectTypeOf } from 'vitest'
import type { ConfigInputPatch } from '../src/index'

const Input = v.object({
	nested: v.object({ left: v.string(), right: v.number() }),
	items: v.array(v.object({ left: v.string(), right: v.number() })),
	pair: v.tuple([v.string(), v.number()]),
	transport: v.variant('kind', [
		v.object({ kind: v.literal('http'), url: v.string() }),
		v.object({ kind: v.literal('socket'), path: v.string() }),
	]),
	converted: v.pipe(v.string(), v.transform(Number)),
})
type Patch = ConfigInputPatch<v.InferInput<typeof Input>>
const predeclared = {
	nested: { left: 'value' },
	transport: { kind: 'http' as const },
	converted: '12',
}
predeclared satisfies Patch
expectTypeOf<Patch['converted']>().toEqualTypeOf<string | undefined>()
const complete = { items: [{ left: 'value', right: 1 }], pair: ['value', 1] } satisfies Patch
expectTypeOf(complete.items).toEqualTypeOf<{ left: string; right: number }[]>()
// @ts-expect-error Arrays replace complete elements; they do not merge partial element fields.
const partialArray: Patch = { items: [{ left: 'value' }] }
// @ts-expect-error Tuples are replaced as complete tuples.
const partialTuple: Patch = { pair: ['value'] }
// @ts-expect-error Configuration uses schema input, never transformed output.
const outputAsInput: Patch = { converted: 12 }
// @ts-expect-error Union fields must belong to the selected discriminant.
const wrongBranch: Patch = { transport: { kind: 'http', path: '/tmp/value' } }
void partialArray
void partialTuple
void outputAsInput
void wrongBranch
