import * as v from 'valibot'

export const test1 = v.object({
	id: v.pipe(v.number(), v.maxValue(10)),
	name: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	tags: v.optional(v.array(v.string()), []),
	check: v.optional(v.boolean(), true),
})

export const test2 = v.object({
	id: v.pipe(v.number(), v.maxValue(10)),
	name: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check: v.optional(v.boolean(), true),
})
