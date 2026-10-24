import { expectTypeOf } from 'vitest'
import * as v from 'valibot'
import { defineTypstDocument } from '../src/template.js'

const schema = v.object({
	title: v.optional(v.string(), 'Default title'),
	amount: v.pipe(v.string(), v.transform(Number)),
})
const document = defineTypstDocument({
	template: './main.typ',
	schema,
	createFiles(data) {
		expectTypeOf(data.title).toEqualTypeOf<string>()
		expectTypeOf(data.amount).toEqualTypeOf<number>()
		return {
			'/inputs/data.json': { kind: 'json', value: data },
			'/inputs/title.txt': { kind: 'text', text: data.title },
		}
	},
})
expectTypeOf(document.schema).toEqualTypeOf<typeof schema>()

// The runtime compiler supplies data.json when createFiles is omitted.
defineTypstDocument({ template: './main.typ', schema: v.object({}) })

defineTypstDocument({
	template: './main.typ',
	schema: v.object({}),
	// @ts-expect-error Names belong to the entry filename.
	name: 'Custom title',
})
defineTypstDocument({
	template: './main.typ',
	// @ts-expect-error Forms require synchronous object schemas.
	schema: v.string(),
})
defineTypstDocument({
	template: './main.typ',
	schema: v.object({}),
	// @ts-expect-error Generated files must be available synchronously.
	createFiles: async () => ({ '/inputs/data.json': { kind: 'json', value: {} } }),
})
