import type { PluginConstructor } from '@pluxel/core'
import { v } from '@pluxel/runtime'
import { bindConfigEnvironment } from './config-environment.ts'

declare const plugin: PluginConstructor
const schema = v.pipe(
	v.object({
		name: v.string(),
		nested: v.optional(
			v.nullable(
				v.object({
					enabled: v.boolean(),
					nullableObject: v.nullable(v.object({ count: v.number() })),
				}),
			),
		),
		values: v.array(v.string()),
		tuple: v.tuple([v.string(), v.number()]),
		record: v.record(v.string(), v.number()),
	}),
	v.transform((input) => ({ normalized: true as const, input })),
)

bindConfigEnvironment(plugin, schema, 'APP_CONFIG_JSON')
bindConfigEnvironment(plugin, schema, {
	name: 'APP_NAME',
	nested: {
		enabled: 'APP_ENABLED',
		nullableObject: { count: 'APP_COUNT' },
	},
	values: 'APP_VALUES',
	tuple: 'APP_TUPLE',
	record: 'APP_RECORD',
})

// @ts-expect-error Mapping follows schema raw input, not transformed output.
bindConfigEnvironment(plugin, schema, { normalized: 'APP_NORMALIZED' })
// @ts-expect-error Unknown object fields are rejected.
bindConfigEnvironment(plugin, schema, { missing: 'APP_MISSING' })
// @ts-expect-error Arrays are environment-name leaves.
bindConfigEnvironment(plugin, schema, { values: { 0: 'APP_FIRST_VALUE' } })
// @ts-expect-error Tuples are environment-name leaves.
bindConfigEnvironment(plugin, schema, { tuple: { 0: 'APP_FIRST_TUPLE_VALUE' } })
// @ts-expect-error Record inputs cannot promise static field completion.
bindConfigEnvironment(plugin, schema, { record: { arbitrary: 'APP_ARBITRARY' } })
