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
				expect.objectContaining({ id: 'tokenizer', path: '/tokenizer' }),
				expect.objectContaining({ id: 'web_search', path: '/web_search' }),
				expect.objectContaining({ id: 'reader', path: '/reader' }),
				expect.objectContaining({ id: 'file_parser.create', path: '/files/parser/create' }),
				expect.objectContaining({
					id: 'file_parser.result',
					path: '/files/parser/result/{task_id}/{format_type}',
				}),
				expect.objectContaining({ id: 'file_parser.sync', path: '/files/parser/sync' }),
			]),
		)
	})

	it('marks upload and path-template operations explicitly', () => {
		expect(zhipuProviderDescriptor.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'ocr.files', inputKind: 'multipart' }),
				expect.objectContaining({ id: 'file_parser.create', inputKind: 'multipart' }),
				expect.objectContaining({ id: 'file_parser.sync', inputKind: 'multipart' }),
				expect.objectContaining({ id: 'file_parser.result', inputKind: 'path' }),
				expect.objectContaining({ id: 'web_search', inputKind: 'json' }),
			]),
		)
	})

	it('keeps generation and agent APIs out of the default GLM tool catalog', () => {
		const ids = zhipuProviderDescriptor.operations.map((operation) => operation.id)

		expect(ids).not.toEqual(
			expect.arrayContaining([
				'images.generations',
				'images.generations.async',
				'videos.generations',
				'agents.create',
			]),
		)
	})
})
