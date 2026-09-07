import {
	createServer,
	request as nodeRequest,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer as createViteServer } from 'vite'

import { createFetchHmrServerPlugin as createFetchDevServerPlugin } from '../../src/hmr/vite-fetch-plugin'

type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: (err?: unknown) => void,
) => void | Promise<void>

function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now()
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) {
				resolve()
				return
			}
			if (Date.now() - started >= timeoutMs) {
				reject(new Error('condition timed out'))
				return
			}
			setTimeout(check, 5)
		}
		check()
	})
}

function disconnectAfterFirstChunk(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = nodeRequest(url, (response) => {
			response.once('data', () => {
				response.destroy()
				request.destroy()
				resolve()
			})
		})
		request.once('error', (error) => {
			if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
		})
		request.end()
	})
}

function requestUpgrade(url: URL, path: string, protocol: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			request.destroy()
			reject(new Error(`upgrade timed out for ${path}`))
		}, 2_000)
		const request = nodeRequest({
			hostname: url.hostname,
			port: url.port,
			path,
			headers: {
				connection: 'Upgrade',
				upgrade: 'websocket',
				'sec-websocket-protocol': protocol,
			},
		})
		request.once('upgrade', (response, socket) => {
			clearTimeout(timeout)
			socket.destroy()
			resolve(response.statusCode ?? 0)
		})
		request.once('response', (response) => {
			clearTimeout(timeout)
			response.resume()
			reject(new Error(`upgrade returned HTTP ${response.statusCode}`))
		})
		request.once('error', (error) => {
			clearTimeout(timeout)
			reject(error)
		})
		request.end()
	})
}

function acceptUpgrade(socket: Duplex): void {
	socket.end(
		'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
	)
}

function waitForViteHmrConnected(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, 'vite-hmr')
		const timeout = setTimeout(() => {
			socket.close()
			reject(new Error('Vite HMR connection timed out'))
		}, 3_000)
		const finish = (error?: Error) => {
			clearTimeout(timeout)
			socket.close()
			if (error) reject(error)
			else resolve()
		}
		socket.addEventListener('message', (event) => {
			try {
				const message = JSON.parse(String(event.data)) as { type?: string }
				if (message.type === 'connected') finish()
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		})
		socket.addEventListener('error', () => finish(new Error('Vite HMR socket failed')))
	})
}

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

	it('runs HTML through Vite while preserving excluded and rejected middleware routes', async () => {
		let middleware: Middleware | undefined
		const transformIndexHtml = vi.fn((_url: string, html: string, _originalUrl?: string) =>
			html.replace('</head>', '<script type="module" src="/@vite/client"></script></head>'),
		)
		const plugin = createFetchDevServerPlugin({
			exclude: [/^\/src\/.+/],
			shouldHandle: (req) => req.url === '/?source=test' || req.url === '/runtime',
			fetch: async (req) =>
				new URL(req.url).pathname === '/'
					? new Response('<!doctype html><html><head></head><body>hmr</body></html>', {
							headers: { 'Content-Type': 'text/html; charset=utf-8' },
						})
					: new Response('handled'),
		})

		plugin.configResolved?.({ base: '/' } as any)
		plugin.configureServer?.({
			config: { base: '/', logger: { error: vi.fn() } },
			transformIndexHtml,
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
		const html = await fetch(`${baseUrl}/?source=test`)
		const excluded = await fetch(`${baseUrl}/src/client.tsx`)
		const skipped = await fetch(`${baseUrl}/vite-asset.js`)
		const handled = await fetch(`${baseUrl}/runtime`)

		expect(html.status).toBe(200)
		expect(await html.text()).toContain('/@vite/client')
		expect(transformIndexHtml).toHaveBeenCalledWith(
			'/',
			'<!doctype html><html><head></head><body>hmr</body></html>',
			'/?source=test',
		)
		expect(excluded.status).toBe(299)
		expect(await excluded.text()).toBe('next')
		expect(skipped.status).toBe(299)
		expect(await skipped.text()).toBe('next')
		expect(handled.status).toBe(200)
		expect(await handled.text()).toBe('handled')
	})

	it('uses srvx cancellation semantics for a disconnected streaming client', async () => {
		let middleware: Middleware | undefined
		let requestAborted = false
		let responseCancelled = false
		const plugin = createFetchDevServerPlugin({
			transformHtml: false,
			fetch: (request) => {
				request.signal.addEventListener('abort', () => {
					requestAborted = true
				})
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('first'))
						},
						cancel() {
							responseCancelled = true
						},
					}),
					{ headers: { 'content-type': 'text/html; charset=utf-8' } },
				)
			},
		})

		plugin.configureServer?.({
			config: { base: '/', logger: { error: vi.fn() } },
			middlewares: {
				use(fn: Middleware) {
					middleware = fn
				},
			},
		} as any)
		if (!middleware) throw new Error('middleware not installed')
		const harness = createMiddlewareHarness(middleware)
		servers.push(harness)

		await disconnectAfterFirstChunk(await harness.listen())
		await waitForCondition(() => requestAborted && responseCancelled)
		expect(requestAborted).toBe(true)
		expect(responseCancelled).toBe(true)
	})

	it('gives the exact Vite HMR path priority and delegates other upgrades to business WS', async () => {
		const businessUpgrades: string[] = []
		const plugin = createFetchDevServerPlugin({
			fetch: () => new Response('http'),
			businessWebSocket: {
				// Deliberately broad: the arbiter, rather than the carrier matcher, must reserve HMR.
				matches: () => true,
				handle(request, socket) {
					businessUpgrades.push(request.url ?? '')
					acceptUpgrade(socket)
				},
			},
		})
		const vite = await createViteServer({
			base: '/app/',
			logLevel: 'silent',
			plugins: [plugin],
			server: {
				host: '127.0.0.1',
				strictPort: false,
				hmr: { path: 'hmr' },
			},
		})
		await vite.listen()
		servers.push({ close: () => vite.close() })
		const address = vite.httpServer?.address() as AddressInfo
		const url = new URL(`http://127.0.0.1:${address.port}`)

		await waitForViteHmrConnected(`ws://127.0.0.1:${address.port}/app/hmr`)
		expect(await requestUpgrade(url, '/business/events', 'business')).toBe(101)
		expect(businessUpgrades).toEqual(['/business/events'])
	})
})
