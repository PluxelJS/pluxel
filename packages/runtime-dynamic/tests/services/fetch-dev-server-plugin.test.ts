import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFetchHmrServerPlugin as createFetchDevServerPlugin } from '../../src/hmr/vite-fetch-plugin'

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
			await new Promise<void>((resolve, reject) =>
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}

					resolve()
				}),
			)
		},
	}
}

describe('createFetchDevServerPlugin', () => {
	const servers: Array<{ close: () => Promise<void> }> = []

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()))
	})

	it('injects the Vite client while preserving excluded and rejected middleware routes', async () => {
		let middleware: Middleware | undefined
		const plugin = createFetchDevServerPlugin({
			exclude: [/^\/src\/.+/],
			shouldHandle: (req) => req.url === '/' || req.url === '/runtime',
			fetch: async (req) =>
				new URL(req.url).pathname === '/'
					? new Response('<!doctype html><html><body>hmr</body></html>', {
							headers: { 'Content-Type': 'text/html; charset=utf-8' },
						})
					: new Response('handled'),
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
		const html = await fetch(`${baseUrl}/`)
		const excluded = await fetch(`${baseUrl}/src/client.tsx`)
		const skipped = await fetch(`${baseUrl}/vite-asset.js`)
		const handled = await fetch(`${baseUrl}/runtime`)

		expect(html.status).toBe(200)
		expect(await html.text()).toContain('/@vite/client')
		expect(excluded.status).toBe(299)
		expect(await excluded.text()).toBe('next')
		expect(skipped.status).toBe(299)
		expect(await skipped.text()).toBe('next')
		expect(handled.status).toBe(200)
		expect(await handled.text()).toBe('handled')
	})
})
