import { formOptions } from '@tanstack/react-form'
import { AutoForm } from '../form'
import * as v from 'valibot'
import * as f from 'valibot-form'

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
	color: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	name: v.optional(v.pipe(v.string(), v.minLength(2)), 'a'),
	check: v.optional(v.boolean(), true),
	// aaa: v.optional(v.picklist(['aa', 'bb']), 'aa'),
})

/* const tranferedData = JSON.parse(JSON.stringify(UserSchema))
console.log(tranferedData) */
export function Home() {
	return (
		<AutoForm
			schema={UserSchema}
			formOpts={formOptions({
				validators: {
					onChange: ({ formApi }) => {
						formApi.setErrorMap({
							onChange: {
								id: [
									{
										kind: 'validation',
										type: 'max_value',
										input: 15,
										expected: '<=10',
										received: '15',
										message: 'Invalid value: Expected <=10 but received 15',
										requirement: 10,
										path: [
											{
												type: 'object',
												origin: 'value',
												input: {
													id: 15,
													color: '#000000',
													name: 'a',
													check: true,
												},
												key: 'id',
												value: 15,
											},
										],
									},
								],
								name: [
									{
										kind: 'validation',
										type: 'min_length',
										input: 'a',
										expected: '>=2',
										received: '1',
										message: 'Invalid length: Expected >=2 but received 1',
										requirement: 2,
										path: [
											{
												type: 'object',
												origin: 'value',
												input: {
													id: 15,
													color: '#000000',
													name: 'a',
													check: true,
												},
												key: 'name',
												value: 'a',
											},
										],
									},
								],
							},
						})
					},
				},
			})}
		/>
	)
}
