import { describe, expect, it } from 'vitest'
import { numberMeta } from '~/core/actions/number'
import { objectMeta } from '~/core/actions/objectMeta'
import { stringMeta } from '~/core/actions/string'
import { META_MAP } from '~/core/utils'

describe('metadata factories', () => {
	it('creates metadata actions with stable references', () => {
		const meta = stringMeta({ placeholder: '名称' })

		expect(meta.kind).toBe('metadata')
		expect(meta.type).toBe(META_MAP.STRING)
		expect(meta.reference).toBe(stringMeta)
		expect(meta.metadata.placeholder).toBe('名称')
	})

	it('keeps number metadata defaults while merging validations', () => {
		const meta = numberMeta({ type: 'input', options: { step: 1 } })

		expect(meta.type).toBe(META_MAP.NUMBER)
		expect(meta.reference).toBe(numberMeta)
		expect(meta.metadata.options.step).toBe(1)
	})

	it('supports object metadata options', () => {
		const meta = objectMeta({ collapse: true })

		expect(meta.type).toBe(META_MAP.object)
		expect(meta.reference).toBe(objectMeta)
		expect(meta.metadata.collapse).toBe(true)
	})
})
