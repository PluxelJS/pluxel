import { expect, expectTypeOf, it } from 'vitest'
import * as v from 'valibot'
import { defineTypstDocument } from '../src/template.js'

it('preserves the schema and infers validated output for virtual files', () => {
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
	expect(document.schema).toBe(schema)
	expect(document.createFiles!(v.parse(schema, { amount: '42' }))).toEqual({
		'/inputs/data.json': { kind: 'json', value: { title: 'Default title', amount: 42 } },
		'/inputs/title.txt': { kind: 'text', text: 'Default title' },
	})
})

it('does not require generated files for the default data.json contract', () => {
	const definition = { template: './main.typ', schema: v.object({}) }
	expect(defineTypstDocument(definition)).toBe(definition)
})

// These are compile-time contracts; executing them would not add runtime evidence.
function invalidDefinitions() {
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
}
void invalidDefinitions
