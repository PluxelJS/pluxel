import { Config, v, f } from './config'
export const test = v.object({
	id: v.pipe(
		v.number(),

		f.numberMeta({
			type: 'slider',
			options: {
				min: 0,
				max: 100,
				step: 5,
				marks: [
					{ value: 0, label: '0' },
					{ value: 5, label: '5' },
					{ value: 10, label: '10' },
				],
			},
		}),
		v.maxValue(10),
	),
	name: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check: v.optional(v.boolean(), true),
	name1: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check1: v.optional(v.boolean(), true),
	name2: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check2: v.optional(v.boolean(), true),
	name3: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check3: v.optional(v.boolean(), true),
	name5: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check56: v.optional(v.boolean(), true),
	name15: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check13: v.optional(v.boolean(), true),
	name22: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check23: v.optional(v.boolean(), true),
	name36: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check34: v.optional(v.boolean(), true),
})

export const test2 = v.object({
	id: v.pipe(v.number(), v.maxValue(10)),
	name: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check: v.optional(v.boolean(), true),
	name1: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check1: v.optional(v.boolean(), true),
	name2: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check2: v.optional(v.boolean(), true),
	name3: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	check3: v.optional(v.boolean(), true),
})
