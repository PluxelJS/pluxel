import { describe, it, expect, beforeEach } from 'vitest'
import * as v from 'valibot'
import { cachedExtractInfo, clearExtractInfoCache } from '~/web/components/schemaCache'

describe('schema cache', () => {
	beforeEach(() => {
		clearExtractInfoCache()
	})

	it('keeps labels isolated per field name even when reusing schemas', () => {
		const sharedSchema = v.string()

		const first = cachedExtractInfo(sharedSchema as any, 'firstName')
		const second = cachedExtractInfo(sharedSchema as any, 'lastName')

		expect(first?.formInfo.label).toBe('First Name')
		expect(second?.formInfo.label).toBe('Last Name')
	})

	it('respects differing defaults when caching', () => {
		const schema = v.string()

		const infoA = cachedExtractInfo(schema as any, 'env', { label: 'Env A' })
		const infoB = cachedExtractInfo(schema as any, 'env', { label: 'Env B' })

		expect(infoA?.formInfo.label).toBe('Env A')
		expect(infoB?.formInfo.label).toBe('Env B')
	})
})
