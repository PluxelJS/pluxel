import { createHost } from '@pluxel/host'
import { resolveContextCapability } from '@pluxel/core/host'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllEnvs())
import { http, HttpServer } from '../src/http'
import { createHostHttpHandler } from '@pluxel/services/http'
import { listenHostHttp } from '@pluxel/services/http/node'

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
