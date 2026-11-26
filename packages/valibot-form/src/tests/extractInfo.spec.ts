import { describe, expect, it, vi } from 'vitest'
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
	name: v.pipe(
		v.string(),
		formMeta({ title: '姓名', description: '旧说明', help: '填写公开名称' }),
		v.description('公开显示名称'),
		stringMeta({ placeholder: '张三' }),
	),
	age: v.optional(
		v.pipe(v.number(), v.minValue(1), v.maxValue(120), v.metadata({ title: '年龄' })),
	),
	address: v.pipe(
		v.object({
			city: v.pipe(v.string(), v.title('城市')),
			zip: v.pipe(v.number(), numberMeta({ step: 1 })),
		}),
		formMeta({ title: '地址信息' }),
		objectMeta({ columns: 2, collapsible: true }),
	),
	role: v.pipe(v.picklist(['user', 'admin']), picklistMeta({ control: 'segmented' })),
	tags: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(3)),
	settings: v.pipe(v.record(v.string(), v.number()), v.minEntries(2), v.maxEntries(4)),
})

describe('extractField / extractFormFields', () => {
	it('extracts top-level fields with labels and required flags', () => {
		const fields = extractFormFields(schema)
		const name = fields.find((f) => f.name === 'name')
		const age = fields.find((f) => f.name === 'age')

		expect(name?.kind).toBe('string')
		expect(name?.meta.label).toBe('姓名')
		expect(name?.meta.description).toBe('公开显示名称')
		expect(name?.meta.help).toBe('填写公开名称')
		expect(name?.meta).not.toHaveProperty('title')
		expect(name?.required).toBe(true)

		expect(age?.kind).toBe('number')
		expect(age?.meta.label).toBe('年龄')
		expect(age?.required).toBe(false)
		if (age?.kind !== 'number') return
		expect(age.min).toBe(1)
		expect(age.max).toBe(120)
	})

	it('derives collection bounds from Valibot validation actions', () => {
		const fields = extractFormFields(schema)
		const tags = fields.find((field) => field.name === 'tags')
		const settings = fields.find((field) => field.name === 'settings')

		expect(tags).toMatchObject({ kind: 'array', min: 1, max: 3 })
		expect(settings).toMatchObject({ kind: 'record', min: 2, max: 4 })
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
		expect(field).toMatchObject({ kind: 'string', control: 'password' })
	})

	it('expands strict objects and marks only the overlapping intersection entry as read-only', () => {
		expect(extractFormFields(v.strictObject({}))).toEqual([])
		expect(() => extractFormFields(v.number())).toThrow(/Form root/)

		const fields = extractFormFields(
			v.intersect([
				v.object({ left: v.number(), both: v.string() }),
				v.strictObject({ right: v.boolean(), both: v.number() }),
			]),
		)
		expect(fields).toEqual([
			expect.objectContaining({ name: 'left', kind: 'number' }),
			expect.objectContaining({
				name: 'both',
				kind: 'unsupported',
				meta: { label: 'Both', readOnly: true },
				reason: 'Intersection contains duplicate key "both"',
			}),
			expect.objectContaining({ name: 'right', kind: 'boolean' }),
		])
	})

	it('distinguishes a missing key from an explicit null without calling defaults', () => {
		const fallback = vi.fn(() => 3)
		const lazy = vi.fn(() => v.string())
		const fields = extractFormFields(
			v.strictObject({
				optional: v.optional(v.number(), fallback),
				nullable: v.nullable(v.number()),
				nullish: v.nullish(v.number()),
				exactOptional: v.exactOptional(v.number()),
				undefinedable: v.undefinedable(v.number()),
				fallback: v.fallback(v.number(), fallback),
				nonNullable: v.nonNullable(v.nullable(v.number())),
				lazy: v.lazy(lazy),
			}),
		)

		expect(fields.map(({ name, required, nullable }) => [name, required, nullable])).toEqual([
			['optional', false, false],
			['nullable', true, true],
			['nullish', false, true],
			['exactOptional', false, false],
			['undefinedable', true, false],
			['fallback', false, false],
			['nonNullable', true, false],
			['lazy', true, false],
		])
		expect(fallback).not.toHaveBeenCalled()
		expect(lazy).not.toHaveBeenCalled()
	})

	it('stops gathering input constraints at the first transform even in a nested pipe', () => {
		const check = vi.fn((input: number) => input > 0)
		const transform = vi.fn((input: number) => input * 10)
		const primitive = v.pipe(v.number(), v.minValue(1), v.check(check), v.transform(transform))
		const transformed = v.pipe(primitive, v.minValue(10), v.maxValue(20), numberMeta({ step: 1 }))
		const array = v.pipe(
			v.array(v.number()),
			v.transform(() => [1, 2]),
			v.minLength(2),
		)
		const [amount, items] = extractFormFields(v.strictObject({ amount: transformed, items: array }))

		expect(amount).toMatchObject({ kind: 'number', min: 1, step: 1 })
		expect(amount).not.toHaveProperty('max')
		expect(items).not.toHaveProperty('min')
		expect(check).not.toHaveBeenCalled()
		expect(transform).not.toHaveBeenCalled()
		expect(v.parse(transformed, 1)).toBe(10)
	})
})
