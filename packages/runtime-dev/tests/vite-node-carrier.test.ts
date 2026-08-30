import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import {
	attachSrvxViteNodeCarrier,
	createSrvxViteNodeCarrierClose,
	dispatchSrvxViteNodeRequest,
} from '../src/vite-node-carrier'

function createServer() {
	const error = vi.fn()
	const ssrFixStacktrace = vi.fn()
	return {
		error,
		server: {
			config: { logger: { error } },
			ssrFixStacktrace,
		} as unknown as ViteDevServer,
		ssrFixStacktrace,
	}
}

function createRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		aborted: false,
		destroyed: false,
		...overrides,
	} as IncomingMessage
}

function createResponse(overrides: Partial<ServerResponse> = {}) {
	const end = vi.fn()
	const destroy = vi.fn()
	return {
		destroy,
		destroyed: false,
		end,
		headersSent: false,
		statusCode: 200,
		statusMessage: 'OK',
		writableEnded: false,
		...overrides,
	} as unknown as ServerResponse
}

function createUpgradeServer() {
	const httpServer = new EventEmitter()
	const use = vi.fn()
	const error = vi.fn()
	const server = {
		config: {
			base: '/base/',
			logger: { error },
			server: { hmr: { path: 'hmr' }, port: 5173 },
		},
		httpServer,
		middlewares: { use },
		ssrFixStacktrace: vi.fn(),
	} as unknown as ViteDevServer
	return { error, httpServer, server, use }
}

function createUpgradeRequest(url: string, protocol?: string): IncomingMessage {
	return {
		headers: protocol === undefined ? {} : { 'sec-websocket-protocol': protocol },
		url,
	} as IncomingMessage
}

describe('Vite Node carrier boundaries', () => {
	it('runs carrier HTML through the active Vite index pipeline', async () => {
		const transformedUrls: string[] = []
		const server = await createViteServer({
			configFile: false,
			appType: 'custom',
			logLevel: 'silent',
			server: { host: '127.0.0.1' },
			plugins: [
				{
					name: 'test-html-transform',
					transformIndexHtml: {
						order: 'pre',
						handler(html, context) {
							transformedUrls.push(context.originalUrl ?? context.path)
							return html.replace('</head>', '<meta name="carrier-transform" /></head>')
						},
					},
				},
				{
					name: 'test-vite-carrier',
					configureServer(vite) {
						attachSrvxViteNodeCarrier(vite, {
							transformViteHtml: true,
							shouldHandle: (request) => request.url?.startsWith('/__pluxel/workbench') ?? false,
							fetch: () =>
								new Response('<!doctype html><html><head></head><body>workbench</body></html>', {
									status: 201,
									headers: {
										'content-length': '1',
										'content-type': 'text/html; charset=utf-8',
										'x-carrier': 'preserved',
									},
								}),
						})
					},
				},
			],
		})
		try {
			await server.listen()
			const address = server.httpServer?.address() as AddressInfo
			const response = await fetch(
				`http://127.0.0.1:${address.port}/__pluxel/workbench?source=test`,
			)
			const html = await response.text()

			expect(response.status).toBe(201)
			expect(response.headers.get('x-carrier')).toBe('preserved')
			expect(response.headers.get('content-length')).not.toBe('1')
			expect(html).toContain('name="carrier-transform"')
			expect(html).toContain('/@vite/client')
			expect(transformedUrls).toEqual(['/__pluxel/workbench?source=test'])
		} finally {
			await server.close()
		}
	})

	it('normalizes and handles a rejected handler without a reason', async () => {
		const { error, server, ssrFixStacktrace } = createServer()
		const response = createResponse()

		dispatchSrvxViteNodeRequest(server, () => Promise.reject(undefined), createRequest(), response)
		await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())

		const reported = error.mock.calls[0]![1].error as Error
		expect(reported).toBeInstanceOf(Error)
		expect(reported.message).toContain('without a rejection reason')
		expect(ssrFixStacktrace).toHaveBeenCalledWith(reported)
		expect(response.statusCode).toBe(500)
		expect(response.statusMessage).toBe('')
		expect(response.end).toHaveBeenCalledOnce()
	})

	it('treats client disconnect rejection as an expected request termination', async () => {
		const { error, server, ssrFixStacktrace } = createServer()
		const response = createResponse({ destroyed: true })

		dispatchSrvxViteNodeRequest(
			server,
			() => Promise.reject(undefined),
			createRequest({ aborted: true }),
			response,
		)
		await Promise.resolve()
		await Promise.resolve()

		expect(error).not.toHaveBeenCalled()
		expect(ssrFixStacktrace).not.toHaveBeenCalled()
		expect(response.end).not.toHaveBeenCalled()
	})

	it('shares one normalized close result across concurrent callers', async () => {
		const detach = vi.fn()
		const closeCarrier = vi.fn(() => Promise.reject(undefined))
		const close = createSrvxViteNodeCarrierClose(detach, closeCarrier)

		const first = close()
		const second = close()
		expect(second).toBe(first)
		await expect(first).rejects.toThrow('srvx carrier close failed without a rejection reason')
		await expect(second).rejects.toThrow('srvx carrier close failed without a rejection reason')
		expect(detach).toHaveBeenCalledOnce()
		expect(closeCarrier).toHaveBeenCalledOnce()
	})

	it.each(['vite-hmr', 'vite-ping'])('leaves exact %s upgrades to Vite', async (protocol) => {
		const { httpServer, server } = createUpgradeServer()
		const matches = vi.fn(() => true)
		const handle = vi.fn()
		const attachment = attachSrvxViteNodeCarrier(server, {
			fetch: () => new Response('Not Found', { status: 404 }),
			businessWebSocket: { matches, handle },
		})
		try {
			httpServer.emit(
				'upgrade',
				createUpgradeRequest('/base/hmr?token=test', protocol),
				new PassThrough(),
				Buffer.alloc(0),
			)
			expect(matches).not.toHaveBeenCalled()
			expect(handle).not.toHaveBeenCalled()
		} finally {
			await attachment.close()
		}
	})

	it('delegates ordinary and non-HMR-path upgrades to the business carrier', async () => {
		const { httpServer, server } = createUpgradeServer()
		const matches = vi.fn(() => true)
		const handle = vi.fn()
		const attachment = attachSrvxViteNodeCarrier(server, {
			fetch: () => new Response('Not Found', { status: 404 }),
			businessWebSocket: { matches, handle },
		})
		try {
			const ordinarySocket = new PassThrough()
			httpServer.emit(
				'upgrade',
				createUpgradeRequest('/__pluxel/runtime/session'),
				ordinarySocket,
				Buffer.from('ordinary'),
			)
			const nonHmrPathSocket = new PassThrough()
			httpServer.emit(
				'upgrade',
				createUpgradeRequest('/business', 'vite-hmr'),
				nonHmrPathSocket,
				Buffer.from('business'),
			)

			expect(matches).toHaveBeenCalledTimes(2)
			expect(handle).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ url: '/__pluxel/runtime/session' }),
				ordinarySocket,
				Buffer.from('ordinary'),
			)
			expect(handle).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ url: '/business' }),
				nonHmrPathSocket,
				Buffer.from('business'),
			)
		} finally {
			await attachment.close()
		}
	})

	it('removes its business upgrade listener when the attachment closes', async () => {
		const { httpServer, server } = createUpgradeServer()
		const matches = vi.fn(() => true)
		const handle = vi.fn()
		const baseline = httpServer.listenerCount('upgrade')
		const attachment = attachSrvxViteNodeCarrier(server, {
			fetch: () => new Response('Not Found', { status: 404 }),
			businessWebSocket: { matches, handle },
		})
		expect(httpServer.listenerCount('upgrade')).toBe(baseline + 1)

		await attachment.close()
		expect(httpServer.listenerCount('upgrade')).toBe(baseline)
		httpServer.emit(
			'upgrade',
			createUpgradeRequest('/__pluxel/runtime/session'),
			new PassThrough(),
			Buffer.alloc(0),
		)
		expect(matches).not.toHaveBeenCalled()
		expect(handle).not.toHaveBeenCalled()
	})
})
