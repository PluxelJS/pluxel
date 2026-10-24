import { expectTypeOf } from 'vitest'
import {
	consumeWorkbenchValue,
	type WorkbenchPortableValue,
	type WorkbenchPortableValueErrorCode,
	type WorkbenchSnapshot,
} from '@pluxel/workbench/client'

const detached = consumeWorkbenchValue({ nested: { value: 'safe' }, items: [1, 2] })
expectTypeOf(detached).toEqualTypeOf<{
	readonly nested: { readonly value: string }
	readonly items: readonly number[]
}>()

const asynchronous = consumeWorkbenchValue(Promise.resolve({ nested: { value: 'safe' } }))
expectTypeOf(asynchronous).toEqualTypeOf<Promise<{ readonly nested: { readonly value: string } }>>()

expectTypeOf<WorkbenchSnapshot<{ value: { count: number } }>>().toEqualTypeOf<{
	readonly value: { readonly count: number }
}>()
expectTypeOf<WorkbenchSnapshot<[string, { count: number }]>>().toEqualTypeOf<
	readonly [string, { readonly count: number }]
>()
expectTypeOf<WorkbenchPortableValueErrorCode>().toEqualTypeOf<
	| 'WORKBENCH_NON_PORTABLE_VALUE'
	| 'WORKBENCH_PORTABLE_VALUE_TOO_DEEP'
	| 'WORKBENCH_PORTABLE_VALUE_TOO_LARGE'
	| 'WORKBENCH_TRANSPORT_DISPOSE_FAILED'
>()
expectTypeOf<WorkbenchPortableValue>().toMatchTypeOf<
	null | boolean | number | string | readonly WorkbenchPortableValue[] | object
>()
