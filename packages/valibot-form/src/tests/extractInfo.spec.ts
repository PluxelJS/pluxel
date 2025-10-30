import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { extractInfo } from '~/extract'
import { arrayMeta } from '~/actions/array'
import { booleanMeta } from '~/actions/boolean'
import { picklistMeta } from '~/actions/picklist'
import { recordMeta } from '~/actions/record'
import { stringMeta } from '~/actions/string'
import { META_MAP } from '~/utils'

describe('extractInfo', () => {
	it('extracts props for string meta and marks required', () => {
		const schema = v.pipe(
			v.string(),
			stringMeta({
				placeholder: '名称',
				secret: true,
			}),
		)

		const info = extractInfo(schema, { title: '名称字段' })
		expect(info?.type).toBe(META_MAP.STRING)
		expect(info?.formInfo.required).toBe(true)
		expect(info?.formInfo.title).toBe('名称字段')
		expect(info?.props.placeholder).toBe('名称')
		expect(info?.props.secret).toBe(true)
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

	it('supports array meta defaults', () => {
		const schema = v.pipe(
			v.array(v.string()),
			arrayMeta({
				style: 'grid',
				columns: 2,
				defaultItem: 'item',
			}),
		)

		const info = extractInfo(schema, { title: '标签' })
		expect(info?.type).toBe(META_MAP.ARRAY)
		expect(info?.props.style).toBe('grid')
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
			}),
		)

		const info = extractInfo(schema, { title: '配置项' })
		expect(info?.type).toBe(META_MAP.RECORD)
		expect(info?.props.addable).toBe(true)
		expect(info?.props.valueMode).toBe('number')
	})
})
