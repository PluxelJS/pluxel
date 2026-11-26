import * as v from 'valibot'
import { describe, expect, it, vi } from 'vitest'
import {
	arrayMeta,
	extractFormFields,
	formMeta,
	numberMeta,
	parseFormFields,
	picklistMeta,
} from '../index'

describe('parseFormFields', () => {
	const schema = v.strictObject({
		amount: v.pipe(
			v.nullable(v.number()),
			formMeta({ description: '', hidden: false, section: { columns: 0, description: '' } }),
			numberMeta({
				step: 0,
				format: {
					style: 'currency',
					currency: 'EUR',
					minimumFractionDigits: 0,
					useGrouping: false,
				},
			}),
		),
		items: v.pipe(
			v.array(v.nullable(v.string())),
			arrayMeta({ defaultItem: null, reorderable: false }),
		),
		seeds: v.pipe(
			v.array(v.object({ count: v.number(), enabled: v.boolean() })),
			arrayMeta({ defaultItem: { count: 0, enabled: false } }),
		),
	})

	it('roundtrips number formatting, explicit null and collection seeds without keeping references', () => {
		const fields = extractFormFields(schema)
		const wire = JSON.parse(JSON.stringify(fields))
		const read = parseFormFields(wire)
		expect(read).toStrictEqual(fields)
		expect(read[0]).toMatchObject({
			kind: 'number',
			required: true,
			nullable: true,
			format: { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, useGrouping: false },
			step: 0,
			meta: { hidden: false, description: '', section: { columns: 0, description: '' } },
		})
		expect(read[1]).toMatchObject({ kind: 'array', defaultItem: null, reorderable: false })
		expect(read[2]).toMatchObject({ defaultItem: { count: 0, enabled: false } })
		expect(Object.isFrozen(read)).toBe(true)
		expect(Object.isFrozen(read[0].meta.section)).toBe(true)
		if (read[2].kind !== 'array') throw new Error('Expected an array field')
		expect(Object.isFrozen(read[2].defaultItem)).toBe(true)
		wire[2].defaultItem.count = 5
		expect(read[2].defaultItem).toEqual({ count: 0, enabled: false })
	})

	it('reports unknown kind, extra options and invalid descendants at the read location', () => {
		const [number, array] = extractFormFields(schema)
		expect(() => parseFormFields([{ ...number, kind: 'number-field' }])).toThrow(
			/fields\[0\]\.kind/,
		)
		expect(() => parseFormFields([{ ...number, meta: { ...number.meta, hepl: 'typo' } }])).toThrow(
			/fields\[0\]\.meta\.hepl/,
		)
		expect(() => parseFormFields([{ ...array, item: { kind: 'number', depth: 1 } }])).toThrow(
			/fields\[0\]\.item\.path/,
		)
		expect(() => parseFormFields([{ ...number, format: { style: 'currency' } }])).toThrow(
			/fields\[0\]\.format must contain valid Intl\.NumberFormat options/,
		)
	})

	it('roundtrips scalar literals and rejects a different wire type or writable literal', () => {
		const fields = extractFormFields(
			v.object({
				disabled: v.literal(false),
				level: v.literal(0),
				code: v.literal('0'),
			}),
		)
		const read = parseFormFields(JSON.parse(JSON.stringify(fields)))
		expect(read.map((field) => ('literal' in field ? field.literal : undefined))).toEqual([
			false,
			0,
			'0',
		])
		for (const field of read) expect(field.meta.readOnly).toBe(true)
		expect(() => parseFormFields([{ ...read[0], literal: 'false' }])).toThrow(
			/fields\[0\]\.literal must be a boolean/,
		)
		expect(() => parseFormFields([{ ...read[1], meta: { label: 'Level' } }])).toThrow(
			/fields\[0\]\.meta\.readOnly/,
		)
	})

	it('rejects accessors, functions, and cyclic inputs without evaluating field data', () => {
		const [number, array] = extractFormFields(schema)
		const getter = vi.fn(() => 'never evaluated')
		const format = Object.defineProperty({}, 'style', { get: getter, enumerable: true })
		expect(() => parseFormFields([{ ...number, format }])).toThrow(
			/fields\[0\]\.format\.style must be a data property/,
		)
		expect(getter).not.toHaveBeenCalled()
		expect(() => parseFormFields([{ ...array, defaultItem: { thunk: () => 1 } }])).toThrow(
			/fields\[0\]\.defaultItem\.thunk is not portable data/,
		)
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		expect(() => parseFormFields([{ ...array, defaultItem: cycle }])).toThrow(
			/fields\[0\]\.defaultItem\.self contains a cycle/,
		)
	})
})

describe('author metadata', () => {
	it('reports a misspelled option or invalid nested format with the authored field name', () => {
		const picklist = v.pipe(
			v.picklist(['a']),
			picklistMeta({
				entries: [{ value: 'a', lable: 'A' } as { value: string }],
			}),
		)
		expect(() => extractFormFields(v.object({ mode: picklist }))).toThrow(
			/mode\.picklistMeta\.entries\[0\]\.lable/,
		)
		const amount = v.pipe(v.number(), numberMeta({ format: { style: 'unit' } }))
		expect(() => extractFormFields(v.object({ amount }))).toThrow(/amount\.numberMeta\.format/)
		const note = v.pipe(v.string(), formMeta({ title: 3 as unknown as string }))
		expect(() => extractFormFields(v.object({ note }))).toThrow(/note\.formMeta\.title/)
	})

	it('represents a nonportable collection seed with a read-only reason', () => {
		const seed = vi.fn(() => 'never evaluated')
		const fields = extractFormFields(
			v.object({
				list: v.pipe(v.array(v.string()), arrayMeta({ defaultItem: seed })),
			}),
		)
		expect(fields[0]).toMatchObject({
			name: 'list',
			kind: 'unsupported',
			meta: { readOnly: true },
			reason: 'list.arrayMeta.defaultItem is not portable data',
		})
		expect(seed).not.toHaveBeenCalled()
		expect(parseFormFields(fields)).toStrictEqual(fields)
	})
})
