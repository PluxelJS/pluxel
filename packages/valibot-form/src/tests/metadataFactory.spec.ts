import { describe, expect, it } from 'vitest'
import { numberMeta, objectMeta, stringMeta, META_TYPES } from '../core/meta'

describe('metadata factories', () => {
	it('creates metadata actions with stable references', () => {
		const meta = stringMeta({ placeholder: '名称' })

		expect(meta.kind).toBe('metadata')
		expect(meta.type).toBe(META_TYPES.STRING)
		expect(meta.reference).toBe(stringMeta)
		expect(meta.metadata.placeholder).toBe('名称')
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
