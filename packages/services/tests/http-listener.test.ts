import { createHost } from '@pluxel/host'
import { BasePlugin, Plugin, pluginDefinitionAddressOf } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import { websocket } from 'elysia/websocket'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllEnvs())
import { http, Http, HttpServer } from '../src/http'
import { createHostHttpHandler } from '@pluxel/services/http'
import { listenHostHttp } from '@pluxel/services/http/node'

@Plugin()
class ListenerSocketProbe extends BasePlugin {
	protected override init() {
		this.ctx
			.require(Http)
			.use(websocket())
			.ws('/probe/socket', {
				message(socket, message) {
					socket.send(message)
				},
			})
	}
}

it.each([false, true])(
	'upgrades business sockets with a shell fallback enabled: %s',
	async (fallback) => {
		const host = await createHost({ plugins: [ListenerSocketProbe], services: [http()] })
		const fallbackFetch = vi.fn(async () => new Response('shell'))
		if (fallback) {
			host.ctx.require(HttpServer).mountFallback({
				matchesRequest: () => true,
				fetch: fallbackFetch,
			})
		}
		await host.startNode({
			definition: pluginDefinitionAddressOf(ListenerSocketProbe),
			variant: 'default',
		})
		const listener = await listenHostHttp(host, {
			fetch: createHostHttpHandler(host),
			hostname: '127.0.0.1',
			port: 0,
		})
		const socket = new WebSocket(`ws://127.0.0.1:${listener.address.port}/probe/socket`)
		try {
			const reply = await new Promise<unknown>((resolve, reject) => {
				socket.addEventListener('open', () => socket.send('echo probe'), { once: true })
				socket.addEventListener('message', (event) => resolve(event.data), { once: true })
				socket.addEventListener('error', () => reject(new Error('WebSocket handshake failed')), {
					once: true,
				})
			})
			expect(reply).toBe('echo probe')
			expect(fallbackFetch).not.toHaveBeenCalled()
		} finally {
			if (socket.readyState !== WebSocket.CLOSED) {
				const closed = new Promise<void>((resolve) =>
					socket.addEventListener('close', () => resolve(), { once: true }),
				)
				socket.close()
				await closed
			}
			await listener.close()
		}
	},
	10_000,
)

it('binds Node request metadata and propagates client disconnect before closing the Host', async () => {
	const host = await createHost({ plugins: [], services: [http()] })
	const entered = Promise.withResolvers<void>()
	const aborted = Promise.withResolvers<void>()
	resolveContextCapability(host.ctx, HttpServer).mountEndpoint({
		prefix: '/probe',
		matchesWebSocketRoute: () => false,
		async fetch(request, carrier) {
			expect(carrier?.requestIP(request)?.address).toBeTruthy()
			if (new URL(request.url).pathname === '/probe/wait') {
				entered.resolve()
				await new Promise<void>((resolve) =>
					request.signal.addEventListener(
						'abort',
						() => {
							aborted.resolve()
							resolve()
						},
						{ once: true },
					),
				)
			}
			return new Response('ok')
		},
	})
	const listener = await listenHostHttp(host, {
		fetch: createHostHttpHandler(host),
		hostname: '127.0.0.1',
		port: 0,
	})
	try {
		const base = `http://127.0.0.1:${listener.address.port}`
		const response = await fetch(`${base}/probe`)
		expect(await response.text()).toBe('ok')
		const controller = new AbortController()
		const request = fetch(`${base}/probe/wait`, { signal: controller.signal }).catch(
			(error: unknown) => error,
		)
		await entered.promise
		controller.abort()
		await request
		await aborted.promise
	} finally {
		await listener.close()
	}
	expect(() => host.start()).toThrow('host is closed')
}, 10000)

it('rejects malformed listener environment before attaching a carrier', async () => {
	const host = await createHost({ plugins: [], services: [http()] })
	try {
		vi.stubEnv('PLUXEL_HOST_PORT', '')
		await expect(listenHostHttp(host, { fetch: createHostHttpHandler(host) })).rejects.toThrow(
			'PLUXEL_HOST_PORT',
		)
	} finally {
		await host.close()
	}
})

it('uses validated Portless bind and port defaults', async () => {
	vi.stubEnv('PLUXEL_HOST_BIND', undefined)
	vi.stubEnv('PLUXEL_HOST_PORT', undefined)
	vi.stubEnv('PORTLESS_URL', 'http://pluxel.localhost:1355')
	vi.stubEnv('HOST', '127.0.0.1')
	vi.stubEnv('PORT', '0')
	const host = await createHost({ plugins: [], services: [http()] })
	const listener = await listenHostHttp(host, { fetch: createHostHttpHandler(host) })
	try {
		expect(listener.address.host).toBe('127.0.0.1')
		expect(listener.address.port).toBeGreaterThan(0)
	} finally {
		await listener.close()
	}
})
