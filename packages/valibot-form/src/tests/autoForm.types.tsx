import * as v from 'valibot'
import { expectTypeOf } from 'vitest'
import { AutoForm, type AutoFormOptions, type ScalarRenderers, webRenderers } from '../web'

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
const renders = {
	number: ({ node, value, path, ...props }) => {
		expectTypeOf(node.kind).toEqualTypeOf<'number'>()
		expectTypeOf(value).toEqualTypeOf<unknown>()
		expectTypeOf(path).toEqualTypeOf<readonly (string | number)[]>()
		return <webRenderers.number node={node} value={value} path={path} {...props} />
	},
} satisfies ScalarRenderers
const misspelled = {
	// @ts-expect-error keys are the four supported scalar kinds
	nubmer: webRenderers.number,
} satisfies ScalarRenderers
const wrongKind = {
	// @ts-expect-error a number renderer receives a number node only
	number: webRenderers.string,
} satisfies ScalarRenderers
void [schemaForm, planForm, invalid, invalidDraft, renders, misspelled, wrongKind]
