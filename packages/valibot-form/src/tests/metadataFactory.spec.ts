import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { readMeta } from '../core'
import { formMeta, numberMeta, objectMeta, stringMeta, META_TYPES } from '../core/meta'

describe('metadata factories', () => {
	it('creates metadata actions with stable references', () => {
		const meta = stringMeta({ placeholder: '名称' })

		expect(meta.kind).toBe('metadata')
		expect(meta.type).toBe(META_TYPES.STRING)
		expect(meta.reference).toBe(stringMeta)
		expect(meta.metadata.placeholder).toBe('名称')
	})

	it('stores form text in standard metadata and keeps presentation preferences grouped', () => {
		const value = {
			title: '名称',
			description: '公开显示名称',
			help: '填写易于辨认的名称',
		} as const
		const meta = formMeta(value)
		const schema = v.pipe(v.string(), meta)

		expect(meta.type).toBe('metadata')
		expect(meta.reference).toBe(v.metadata)
		expect(meta.metadata).toMatchObject({
			title: value.title,
			description: value.description,
			'valibot-form': { help: value.help },
		})
		expect(v.getMetadata(schema)).toMatchObject({
			title: value.title,
			description: value.description,
		})
		expect(readMeta(schema, META_TYPES.FORM)).toEqual(value)
	})

	it('supports number metadata options', () => {
		const meta = numberMeta({ step: 1 })

		expect(meta.type).toBe(META_TYPES.NUMBER)
		expect(meta.reference).toBe(numberMeta)
		expect(meta.metadata.step).toBe(1)
	})

	it('supports object metadata options', () => {
		const meta = objectMeta({ collapsible: true, columns: 2 })

		expect(meta.type).toBe(META_TYPES.OBJECT)
		expect(meta.reference).toBe(objectMeta)
		expect(meta.metadata.collapsible).toBe(true)
		expect(meta.metadata.columns).toBe(2)
	})
})
