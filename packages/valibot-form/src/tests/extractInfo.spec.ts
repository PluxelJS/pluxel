import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
	extractField,
	extractFormFields,
	formMeta,
	numberMeta,
	objectMeta,
	picklistMeta,
	stringMeta,
} from '../core'

const schema = v.object({
	name: v.pipe(v.string(), formMeta({ label: '姓名' }), stringMeta({ placeholder: '张三' })),
	age: v.pipe(v.optional(v.number()), numberMeta({ min: 1, max: 120 })),
	address: v.pipe(
		v.object({
			city: v.pipe(v.string(), formMeta({ label: '城市' })),
			zip: v.pipe(v.number(), numberMeta({ step: 1 })),
		}),
		formMeta({ label: '地址信息' }),
		objectMeta({ columns: 2, collapsible: true }),
	),
	role: v.pipe(v.picklist(['user', 'admin']), picklistMeta({ control: 'segmented' })),
})

describe('extractField / extractFormFields', () => {
	it('extracts top-level fields with labels and required flags', () => {
		const fields = extractFormFields(schema)
		const name = fields.find((f) => f.name === 'name')
		const age = fields.find((f) => f.name === 'age')

		expect(name?.kind).toBe('string')
		expect(name?.meta.label).toBe('姓名')
		expect(name?.required).toBe(true)

		expect(age?.kind).toBe('number')
		expect(age?.required).toBe(false)
	})

	it('extracts object fields and metadata', () => {
		const fields = extractFormFields(schema)
		const address = fields.find((f) => f.name === 'address')
		expect(address?.kind).toBe('object')
		if (address?.kind !== 'object') return
		expect(address.fields.length).toBe(2)
		expect(address.collapsible).toBe(true)
	})

	it('extracts standalone field via extractField', () => {
		const field = extractField(v.pipe(v.string(), stringMeta({ control: 'password' })), {
			fieldName: 'token',
			path: 'token',
		})
		expect(field?.kind).toBe('string')
		expect((field as any).control).toBe('password')
	})
})
