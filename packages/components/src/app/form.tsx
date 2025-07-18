import { AutoForm, f, v } from '../form'

const UserSchema = v.object({
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
	// aaa: v.optional(v.picklist(['aa', 'bb']), 'aa'),
})

export function Home() {
	return (
		<AutoForm schema={UserSchema} onSubmit={(value) => console.log(value.id)} />
	)
}
