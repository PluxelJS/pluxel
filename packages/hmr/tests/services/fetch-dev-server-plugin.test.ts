import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFetchDevServerPlugin } from '@pluxel/hmr/services/http/vite-fetch-plugin'

type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: (err?: unknown) => void,
) => void | Promise<void>

function createMiddlewareHarness(middleware: Middleware) {
	const server = createServer((req, res) => {
		middleware(req, res, (err) => {
			if (err) {
				res.statusCode = 500
				res.end(String(err))
				return
			}

			res.statusCode = 299
			res.setHeader('Content-Type', 'text/plain; charset=utf-8')
			res.end('next')
		})
	})

	return {
		async listen() {
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
			const addr = server.address()
			if (!addr || typeof addr === 'string') throw new Error('server address unavailable')
			return `http://127.0.0.1:${addr.port}`
		},
		async close() {
			await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
		},
	}
}

describe('createFetchDevServerPlugin', () => {
	const servers: Array<{ close: () => Promise<void> }> = []

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()))
	})

	it('injects /@vite/client into HTML responses', async () => {
		let middleware: Middleware | undefined
		const plugin = createFetchDevServerPlugin({
			fetch: async () =>
				new Response('<!doctype html><html><body>hmr</body></html>', {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				}),
		})

		plugin.configResolved?.({ base: '/' } as any)
		plugin.configureServer?.({
			middlewares: {
				use(fn: Middleware) {
					middleware = fn
				},
			},
			ssrFixStacktrace: vi.fn(),
		} as any)

		if (!middleware) throw new Error('middleware not installed')
		const harness = createMiddlewareHarness(middleware)
		servers.push(harness)

		const baseUrl = await harness.listen()
		const res = await fetch(`${baseUrl}/`)
		expect(res.status).toBe(200)
		expect(await res.text()).toContain('/@vite/client')
	})

	it('passes excluded requests to the next middleware', async () => {
		let middleware: Middleware | undefined
		const plugin = createFetchDevServerPlugin({
			exclude: [/^\/src\/.+/],
			fetch: async () => new Response('handled'),
		})

		plugin.configResolved?.({ base: '/' } as any)
		plugin.configureServer?.({
			middlewares: {
				use(fn: Middleware) {
					middleware = fn
				},
			},
			ssrFixStacktrace: vi.fn(),
		} as any)

		if (!middleware) throw new Error('middleware not installed')
		const harness = createMiddlewareHarness(middleware)
		servers.push(harness)

		const baseUrl = await harness.listen()
		const res = await fetch(`${baseUrl}/src/client.tsx`)
		expect(res.status).toBe(299)
		expect(await res.text()).toBe('next')
	})
})
