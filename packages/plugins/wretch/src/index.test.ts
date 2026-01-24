import '@pluxel/core/test/setup'

import { describe, expect, it } from 'bun:test'
import { withTestHost } from '@pluxel/core/test'
import { WretchPlugin } from './index'

describe('pluxel-plugin-wretch', () => {
	it('builds requests using baseUrl from config (config is optional)', async () => {
		const prevFetch = globalThis.fetch
		let lastUrl: string | null = null

		const stubFetch = (async (input: RequestInfo | URL) => {
			lastUrl =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.toString()
						: input instanceof Request
							? input.url
							: String(input)
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}) satisfies typeof fetch
		globalThis.fetch = stubFetch

		try {
			await withTestHost(async (host) => {
				await host.ctx.configService.ready
				host.setConfig(WretchPlugin, { wretch: { baseUrl: 'https://api.example.com/' } })
				await host.start(WretchPlugin)

				const instance = host.getOrThrow(WretchPlugin) as WretchPlugin
				expect((instance as any).wretch).toEqual({ baseUrl: 'https://api.example.com/' })
				await instance.getJson('/ping')
				expect(lastUrl).toBe('https://api.example.com/ping')
			})
		} finally {
			globalThis.fetch = prevFetch
		}
	})
})
