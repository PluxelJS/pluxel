import { describe, expect, it } from 'vitest'
import { parseUpstreamError, previewJson, requestPreview } from './preview'

describe('Zhipu request preview', () => {
	it('summarizes data URLs in file fields without retaining base64 content', () => {
		const preview = previewJson({
			model: 'glm-ocr',
			file: `data:image/jpeg;base64,${'a'.repeat(1200)}`,
			prompt: '提取金额',
		})

		expect(preview).toContain('data:image/jpeg;base64;bytes=900')
		expect(preview).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa')
		expect(preview).toContain('提取金额')
	})

	it('summarizes large base64-looking strings outside file fields', () => {
		const preview = requestPreview({
			file: 'https://example.com/invoice.pdf',
			image: 'A'.repeat(800),
		})

		expect(preview).toContain('https://example.com/invoice.pdf')
		expect(preview).toContain('base64:600 bytes')
		expect(preview).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA')
	})
})

describe('Zhipu upstream error parsing', () => {
	it('extracts nested OpenAPI error details', () => {
		const error = parseUpstreamError(
			JSON.stringify({
				error: {
					code: 'invalid_request',
					message: 'file is required',
					request_id: 'req-1',
				},
			}),
			'application/json',
			400,
		)

		expect(error).toEqual({
			code: 'invalid_request',
			message: 'file is required',
			requestId: 'req-1',
		})
	})

	it('falls back to response text for non-json errors', () => {
		expect(parseUpstreamError('bad gateway', 'text/plain', 502)).toEqual({
			message: 'bad gateway',
		})
	})
})
