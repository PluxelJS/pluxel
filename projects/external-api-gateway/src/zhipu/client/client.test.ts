import { describe, expect, it } from 'vitest'
import { createZhipuClient } from './client'

describe('ZhipuClient URL normalization', () => {
	it('does not duplicate /paas/v4 when callers pass official spec paths', () => {
		const client = createZhipuClient({
			apiKey: 'test',
			baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		})

		expect(client.url('/paas/v4/web_search').toString()).toBe(
			'https://open.bigmodel.cn/api/paas/v4/web_search',
		)
	})

	it('routes /v1 paths to the API root when baseUrl points at /paas/v4', () => {
		const client = createZhipuClient({
			apiKey: 'test',
			baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		})

		expect(client.url('/v1/example').toString()).toBe('https://open.bigmodel.cn/api/v1/example')
	})

	it('keeps /paas/v4 paths when baseUrl is the API root', () => {
		const client = createZhipuClient({
			apiKey: 'test',
			baseUrl: 'https://api.z.ai/api',
		})

		expect(client.url('/paas/v4/chat/completions').toString()).toBe(
			'https://api.z.ai/api/paas/v4/chat/completions',
		)
	})
})
