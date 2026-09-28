import * as v from 'valibot'
import { expectTypeOf } from 'vitest'
import { AutoForm, type AutoFormOptions } from '../web'

const schema = v.object({ count: v.pipe(v.string(), v.transform(Number)) })
const schemaForm = (
	<AutoForm
		schema={schema}
		formOpts={{
			defaultValues: { count: '12' },
			validators: {
				onSubmit: ({ value }) => {
					expectTypeOf(value.count).toEqualTypeOf<string>()
					return undefined
				},
			},
			onSubmit: ({ value }) => {
				expectTypeOf(value.count).toEqualTypeOf<string>()
			},
		}}
	>
		{null}
	</AutoForm>
)
const planForm = (
	<AutoForm
		fields={[]}
		formOpts={{
			defaultValues: { title: 'draft' },
			onSubmit: ({ value }) => {
				expectTypeOf(value.title).toEqualTypeOf<string>()
			},
		}}
	>
		{null}
	</AutoForm>
)
const invalid: AutoFormOptions<{ count: string }> = {
	// @ts-expect-error options are not an arbitrary dictionary
	onSumbit: () => {},
}
const invalidDraft: AutoFormOptions<v.InferInput<typeof schema>> = {
	// @ts-expect-error transformed output is not a draft input
	defaultValues: { count: 12 },
}
void [schemaForm, planForm, invalid, invalidDraft]
