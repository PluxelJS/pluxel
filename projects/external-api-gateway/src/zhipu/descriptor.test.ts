import { describe, expect, it } from 'vitest'
import { zhipuProviderDescriptor } from './descriptor'

describe('Zhipu provider descriptor', () => {
	it('keeps provider operation ids unique', () => {
		const ids = zhipuProviderDescriptor.operations.map((operation) => operation.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('describes the typed operations used by the gateway', () => {
		expect(zhipuProviderDescriptor).toMatchObject({
			id: 'zhipu',
			pluginId: 'ZhipuProviderPlugin',
		})
		expect(zhipuProviderDescriptor.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'ocr.layout_parsing', path: '/layout_parsing' }),
				expect.objectContaining({ id: 'chat.completions', path: '/chat/completions' }),
				expect.objectContaining({ id: 'web_search', path: '/web_search' }),
			]),
		)
	})
})
