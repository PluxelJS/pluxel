import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { arrayMeta } from '~/core/actions/array'
import { booleanMeta } from '~/core/actions/boolean'
import { numberMeta } from '~/core/actions/number'
import { objectMeta } from '~/core/actions/objectMeta'
import { picklistMeta } from '~/core/actions/picklist'
import { recordMeta } from '~/core/actions/record'
import { stringMeta } from '~/core/actions/string'
import { extractInfo } from '~/core/extract'
import { META_MAP } from '~/core/utils'

describe('extractInfo', () => {
	it('extracts props for string meta and marks required', () => {
		const schema = v.pipe(
			v.string(),
			stringMeta({
				placeholder: '名称',
				mode: 'password',
				copyable: true,
			}),
		)

		const info = extractInfo(schema, { label: '名称字段' })
		expect(info?.type).toBe(META_MAP.STRING)
		expect(info?.formInfo.required).toBe(true)
		expect(info?.formInfo.label).toBe('名称字段')
		expect(info?.props.placeholder).toBe('名称')
		expect(info?.props.mode).toBe('password')
		expect(info?.props.copyable).toBe(true)
	})

	it('marks optional schemas as not required', () => {
		const optionalSchema = v.optional(
			v.pipe(
				v.boolean(),
				booleanMeta({
					label: '接受条款',
				}),
			),
		)

		const info = extractInfo(optionalSchema, { title: '是否接受条款' })
		expect(info?.type).toBe(META_MAP.BOOLEAN)
		expect(info?.formInfo.required).toBe(false)
	})

	it('falls back to provided defaults when no form metadata exists', () => {
		const schema = v.pipe(v.string())

		const info = extractInfo(schema, {
			label: '用户名',
			description: '用于登录的名称',
		})

		expect(info?.formInfo.label).toBe('用户名')
		expect(info?.formInfo.description).toBe('用于登录的名称')
		expect(info?.formInfo.required).toBe(true)
	})

	it('merges number validations into meta options', () => {
		const schema = v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(5),
			numberMeta({
				variant: 'slider',
				step: 2,
			}),
		)

		const info = extractInfo(schema, { title: '数量' })

		expect(info?.type).toBe(META_MAP.NUMBER)
		expect(info?.props.variant).toBe('slider')
		expect(info?.props.integer).toBe(true)
		expect(info?.props.min).toBe(1)
		expect(info?.props.max).toBe(5)
		expect(info?.props.step).toBe(2)
	})

	it('supports array meta defaults', () => {
		const schema = v.pipe(
			v.array(v.string()),
			arrayMeta({
				layout: 'grid',
				columns: 2,
				defaultItem: 'item',
			}),
		)

		const info = extractInfo(schema, { title: '标签' })
		expect(info?.type).toBe(META_MAP.ARRAY)
		expect(info?.props.layout).toBe('grid')
		expect(info?.props.columns).toBe(2)
		expect(info?.props.defaultItem).toBe('item')
	})

	it('supports picklist meta with labels', () => {
		const schema = v.pipe(
			v.picklist(['dev', 'prod'] as const),
			picklistMeta({
				labels: {
					dev: '开发',
					prod: '生产',
				},
				placeholder: '选择环境',
			}),
		)

		const info = extractInfo(schema, { title: '环境' })
		expect(info?.type).toBe(META_MAP.PICKLIST)
		expect(info?.props.placeholder).toBe('选择环境')
		expect(info?.props.labels?.dev).toBe('开发')
	})

	it('supports record meta variants', () => {
		const schema = v.pipe(
			v.record(v.string(), v.number()),
			recordMeta({
				addable: true,
				reorderable: true,
				valueMode: 'number',
				layout: 'list',
			}),
		)

		const info = extractInfo(schema, { title: '配置项' })
		expect(info?.type).toBe(META_MAP.RECORD)
		expect(info?.props.addable).toBe(true)
		expect(info?.props.valueMode).toBe('number')
		expect(info?.props.layout).toBe('list')
	})

	it('returns undefined for unsupported schema types', () => {
		const info = extractInfo(v.literal('固定值'), { title: '常量' })
		expect(info).toBeUndefined()
	})

	it('extracts nested object fields with metadata', () => {
		const schema = v.pipe(
			v.object({
				street: v.pipe(v.string(), stringMeta({ placeholder: '街道' })),
				zip: v.number(),
			}),
			objectMeta({ columns: 2, collapse: true }),
		)

		const info = extractInfo(schema, { title: '地址信息' })
		expect(info?.type).toBe(META_MAP.object)
		expect(info?.props.fields.map((field) => field.name)).toEqual(['street', 'zip'])
		expect(info?.props.columns).toBe(2)
		expect(info?.props.collapse).toBe(true)
	})

	it('treats intersections of objects as object fields', () => {
		const schema = v.intersect([
			v.object({ firstName: v.string() }),
			v.object({ lastName: v.string() }),
		])

		const info = extractInfo(schema, { title: '姓名' })
		expect(info?.type).toBe(META_MAP.object)
		expect(info?.props.fields.map((field) => field.name).sort()).toEqual(['firstName', 'lastName'])
	})
})
