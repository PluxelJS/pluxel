import { describe, expect, it } from 'vitest'
import { isExtractableType, META_MAP } from '~/core/utils'

describe('extract type helpers', () => {
	it('accepts known extractable meta types', () => {
		expect(isExtractableType(META_MAP.STRING)).toBe(true)
		expect(isExtractableType(META_MAP.NUMBER)).toBe(true)
	})

	it('rejects unsupported meta types', () => {
		expect(isExtractableType(META_MAP.FORM)).toBe(false)
		expect(isExtractableType('unknown')).toBe(false)
	})
})
