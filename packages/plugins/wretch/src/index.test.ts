import '@pluxel/core/test/setup'

import { describe, expect, it } from 'bun:test'
import { __registerConfigSchema__ } from '@pluxel/core'
import { withTestHost } from '@pluxel/core/test'
import { WretchPlugin } from './index'
import { WretchConfig } from './schema'

// In production this is injected by configSourcePlugin.
__registerConfigSchema__(WretchPlugin, 'wretch', WretchConfig)

type FetchCapture = {
	url: string | null
	headers: Record<string, string> | null
	init: RequestInit | undefined
}

const toUrlString = (input: RequestInfo | URL): string =>
	typeof input === 'string'
		? input
		: input instanceof URL
			? input.toString()
			: input instanceof Request
				? input.url
				: String(input)

async function withStubFetch<T>(run: (cap: FetchCapture) => Promise<T>): Promise<T> {
	const prevFetch = globalThis.fetch
	const cap: FetchCapture = { url: null, headers: null, init: undefined }

	const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		cap.url = toUrlString(input)
		cap.init = init
		cap.headers = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : null

		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) satisfies typeof fetch

	globalThis.fetch = stubFetch
	try {
		return await run(cap)
	} finally {
		globalThis.fetch = prevFetch
	}
}

async function withWretchPlugin<T>(
	config: Record<string, unknown>,
	run: (instance: WretchPlugin) => Promise<T>,
): Promise<T> {
	return withTestHost(async (host) => {
		await host.ctx.configService.ready
		host.setConfig(WretchPlugin, { wretch: config })
		await host.start(WretchPlugin)
		return run(host.getOrThrow(WretchPlugin) as WretchPlugin)
	})
}

describe('@pluxel/wretch', () => {
	it('supports named clients + defaultClient selection', async () => {
		await withStubFetch(async (cap) => {
			await withWretchPlugin(
				{
					defaultClient: 'prod',
					defaults: { baseUrl: 'https://default.example.com/' },
					clients: { prod: { baseUrl: 'https://prod.example.com/' } },
				},
				async (instance) => {
					await instance.client().get('/ping').json()
					expect(cap.url).toBe('https://prod.example.com/ping')

					await instance.client('default').get('/ping').json()
					expect(cap.url).toBe('https://default.example.com/ping')

					await instance.client('prod').get('/pong').json()
					expect(cap.url).toBe('https://prod.example.com/pong')
				},
			)
		})
	})

	it('merges per-request headers and supports query helper', async () => {
		await withStubFetch(async (cap) => {
			await withWretchPlugin(
				{
					defaults: { baseUrl: 'https://api.example.com/', headers: { 'x-a': '1' } },
					clients: { prod: { headers: { 'x-b': '2' } } },
					defaultClient: 'prod',
				},
				async (instance) => {
					await instance
						.client()
						.headers({ 'x-c': '3' })
						.url('/ping')
						.query({ a: 1, b: 'x' })
						.get()
						.json()
				},
			)
			expect(cap.url).toBe('https://api.example.com/ping?a=1&b=x')
			expect(cap.headers).toMatchObject({ 'x-a': '1', 'x-b': '2', 'x-c': '3' })
		})
	})

	it('falls back to default client when defaultClient is missing', async () => {
		await withStubFetch(async (cap) => {
			await withWretchPlugin(
				{
					defaultClient: 'does-not-exist',
					defaults: { baseUrl: 'https://api.example.com/' },
					clients: { prod: { baseUrl: 'https://prod.example.com/' } },
				},
				async (instance) => {
					await instance.client().get('/ping').json()
				},
			)
			expect(cap.url).toBe('https://api.example.com/ping')
		})
	})

	it('applies credentials/options to fetch init', async () => {
		await withStubFetch(async (cap) => {
			await withWretchPlugin(
				{
					defaults: {
						baseUrl: 'https://api.example.com/',
						credentials: 'include',
						options: { mode: 'cors' },
					},
				},
				async (instance) => {
					await instance.client().get('/ping').json()
				},
			)
			expect(cap.init?.credentials).toBe('include')
			expect(cap.init?.mode).toBe('cors')
		})
	})
})
