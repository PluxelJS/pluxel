import { createHost } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { BasePlugin, Plugin } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import { websocket } from 'elysia/websocket'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'srvx'

afterEach(() => vi.unstubAllEnvs())
import { elysia, ElysiaApp } from '../src/elysia'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { listenElysia } from '@pluxel/services/elysia/node'

@Plugin()
class ListenerSocketProbe extends BasePlugin {
	protected override init() {
		this.ctx
			.require(ElysiaApp)
			.use(websocket())
			.ws('/probe/socket', {
				message(socket, message) {
					socket.send(message)
				},
			})
	}
}

let cancelDocumentStream: ((reason: unknown) => void) | undefined

@Plugin()
class ListenerHttpProbe extends BasePlugin {
	protected override init() {
		this.ctx
			.require(ElysiaApp)
			.get(
				'/documents/missing',
				() =>
					new Response('document does not exist', {
						status: 404,
						headers: { 'content-type': 'text/plain', 'x-response-owner': 'document' },
					}),
			)
			.get(
				'/documents/stream',
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('document stream'))
							},
							cancel(reason) {
								cancelDocumentStream?.(reason)
							},
						}),
						{ status: 404, headers: { 'content-type': 'application/pdf' } },
					),
			)
	}
}

it('preserves handled 404 responses before considering application assets', async () => {
	const publicDir = await mkdtemp(join(tmpdir(), 'pluxel-listener-owned-'))
	await writeFile(join(publicDir, 'index.html'), '<main>application</main>')
	const host = await createHost({ plugins: [ListenerHttpProbe], services: [elysia()] })
	try {
		const http = resolveContextCapability(host.ctx, ElysiaRuntime)
		http.mountEndpoint({
			prefix: '/endpoint',
			matchesWebSocketRoute: () => false,
			fetch: async () => new Response('endpoint missing', { status: 404 }),
		})
		http.mountFallback({
			matchesRequest: (request) => new URL(request.url).pathname.startsWith('/shell/'),
			fetch: async (request) =>
				new URL(request.url).pathname.startsWith('/shell/')
					? new Response('shell missing', { status: 404 })
					: null,
		})
		await host.startNode(ListenerHttpProbe.nodeAddress())
		const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 0, publicDir })
		try {
			const origin = `http://127.0.0.1:${listener.address.port}`
			const document = await fetch(`${origin}/documents/missing`, {
				headers: { accept: 'text/html' },
			})
			expect(document.status).toBe(404)
			expect(document.headers.get('content-type')).toBe('text/plain')
			expect(document.headers.get('x-response-owner')).toBe('document')
			expect(await document.text()).toBe('document does not exist')
			for (const owner of ['endpoint', 'shell']) {
				const response = await fetch(`${origin}/${owner}/missing`, {
					headers: { accept: 'text/html' },
				})
				expect(response.status).toBe(404)
				expect(await response.text()).toBe(`${owner} missing`)
			}
			const unmatched = await fetch(`${origin}/application/page`, {
				headers: { accept: 'text/html' },
			})
			expect(unmatched.status).toBe(200)
			expect(await unmatched.text()).toBe('<main>application</main>')
		} finally {
			await listener.close()
		}
	} finally {
		await host.close()
		await rm(publicDir, { recursive: true, force: true })
	}
})

it('cancels a handled 404 stream when its client disconnects with public assets enabled', async () => {
	const publicDir = await mkdtemp(join(tmpdir(), 'pluxel-listener-stream-'))
	await writeFile(join(publicDir, 'index.html'), '<main>application</main>')
	const host = await createHost({ plugins: [ListenerHttpProbe], services: [elysia()] })
	const cancelled = Promise.withResolvers<unknown>()
	cancelDocumentStream = cancelled.resolve
	try {
		await host.startNode(ListenerHttpProbe.nodeAddress())
		const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 0, publicDir })
		try {
			const response = await fetch(`http://127.0.0.1:${listener.address.port}/documents/stream`, {
				headers: { accept: 'text/html' },
			})
			expect(response.status).toBe(404)
			expect(response.headers.get('content-type')).toBe('application/pdf')
			const reader = response.body!.getReader()
			const first = await reader.read()
			expect(new TextDecoder().decode(first.value)).toBe('document stream')
			await reader.cancel()
			expect(await cancelled.promise).toBeInstanceOf(Error)
		} finally {
			await listener.close()
		}
	} finally {
		cancelDocumentStream = undefined
		await host.close()
		await rm(publicDir, { recursive: true, force: true })
	}
}, 10000)

it.each([false, true])(
	'upgrades business sockets with a shell fallback enabled: %s',
	async (fallback) => {
		const host = await createHost({ plugins: [ListenerSocketProbe], services: [elysia()] })
		const fallbackFetch = vi.fn(async () => new Response('shell'))
		if (fallback) {
			host.ctx.require(ElysiaRuntime).mountFallback({
				matchesRequest: () => true,
				fetch: fallbackFetch,
			})
		}
		await host.startNode({
			definition: ListenerSocketProbe.definitionAddress(),
			variant: 'default',
		})
		const listener = await listenElysia(host, {
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

it('closes its physical listener, stream and WebSocket through the Host lifetime', async () => {
	const host = await createHost({
		plugins: [ListenerHttpProbe, ListenerSocketProbe],
		services: [elysia()],
		policy: { autoStart: [ListenerHttpProbe, ListenerSocketProbe] },
	})
	const cancelled = Promise.withResolvers<unknown>()
	cancelDocumentStream = cancelled.resolve
	let native: Server | undefined
	let socket: WebSocket | undefined
	try {
		await host.start()
		const listener = await listenElysia(host, {
			hostname: '127.0.0.1',
			port: 0,
			plugins: [
				(server) => {
					native = server
				},
			],
		})
		const origin = `http://127.0.0.1:${listener.address.port}`
		const response = await fetch(`${origin}/documents/stream`)
		const reader = response.body!.getReader()
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toBe('document stream')
		const reading = reader.read().catch((error: unknown) => error)
		socket = new WebSocket(`ws://127.0.0.1:${listener.address.port}/probe/socket`)
		await new Promise<void>((resolve, reject) => {
			socket!.addEventListener('open', () => resolve(), { once: true })
			socket!.addEventListener('error', () => reject(new Error('WebSocket handshake failed')), {
				once: true,
			})
		})
		const socketClosed = new Promise<void>((resolve) =>
			socket!.addEventListener('close', () => resolve(), { once: true }),
		)
		const closePhysical = vi.spyOn(native!, 'close')
		const closing = host.close()
		expect(host.close()).toBe(closing)
		expect(listener.close()).toBe(closing)
		await Promise.all([closing, socketClosed, reading])
		expect(await cancelled.promise).toBeInstanceOf(Error)
		expect(closePhysical).toHaveBeenCalledTimes(1)
		expect(native!.node!.server.listening).toBe(false)
		await expect(fetch(`${origin}/documents/missing`)).rejects.toThrow('fetch failed')
	} finally {
		cancelDocumentStream = undefined
		socket?.close()
		await host.close()
	}
}, 10000)

it('settles concurrent Host close during listener acquisition without retaining the startup lease', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	let native: Server | undefined
	let closing: Promise<void> | undefined
	try {
		await expect(
			listenElysia(host, {
				hostname: '127.0.0.1',
				port: 0,
				plugins: [
					(server) => {
						native = server
						closing = host.close()
					},
				],
			}),
		).rejects.toThrow('Plugin owner stopped')
		await closing
		expect(native!.node!.server.listening).toBe(false)
	} finally {
		await host.close()
	}
})

it('preserves listener startup failure and Host cleanup failure while releasing the carrier', async () => {
	const occupied = await createHost({ plugins: [], services: [elysia()] })
	const listener = await listenElysia(occupied, { hostname: '127.0.0.1', port: 0 })
	const host = await createHost({ plugins: [], services: [elysia()] })
	const cleanupFailure = new Error('cleanup probe')
	host.ctx.effects.defer(() => {
		throw cleanupFailure
	})
	try {
		const error = await listenElysia(host, {
			hostname: '127.0.0.1',
			port: listener.address.port,
		}).catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(AggregateError)
		const failure = error as AggregateError
		expect(failure.cause).toMatchObject({ code: 'EADDRINUSE' })
		expect(failure.errors[0]).toBe(failure.cause)
		const errors = (cause: unknown): unknown[] =>
			cause instanceof AggregateError ? cause.errors.flatMap(errors) : [cause]
		expect(errors(failure.errors[1])).toContain(cleanupFailure)
		expect(() => host.start()).toThrow('host is closed')
	} finally {
		await Promise.allSettled([host.close(), listener.close()])
	}
})

it('binds Node request metadata and propagates client disconnect before closing the Host', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	const entered = Promise.withResolvers<void>()
	const aborted = Promise.withResolvers<void>()
	resolveContextCapability(host.ctx, ElysiaRuntime).mountEndpoint({
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
	const listener = await listenElysia(host, {
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

it('propagates disconnect after a streaming response has started', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	const aborted = Promise.withResolvers<{ aborted: boolean; reason: unknown }>()
	resolveContextCapability(host.ctx, ElysiaRuntime).mountEndpoint({
		prefix: '/stream',
		matchesWebSocketRoute: () => false,
		async fetch(request) {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('ready'))
						request.signal.addEventListener(
							'abort',
							() => {
								aborted.resolve({ aborted: request.signal.aborted, reason: request.signal.reason })
								controller.close()
							},
							{ once: true },
						)
					},
				}),
			)
		},
	})
	const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 0 })
	try {
		const response = await fetch(`http://127.0.0.1:${listener.address.port}/stream`)
		const reader = response.body!.getReader()
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toBe('ready')
		await reader.cancel()
		const cancellation = await aborted.promise
		expect(cancellation.aborted).toBe(true)
		expect(cancellation.reason).toBeInstanceOf(Error)
	} finally {
		await listener.close()
	}
}, 10000)

it('does not resolve global environment when the caller supplies listener options', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	vi.stubEnv('PLUXEL_HOST_PORT', 'invalid')
	vi.stubEnv('PLUXEL_PUBLIC_ORIGIN', 'not-an-origin')
	const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 0 })
	try {
		expect(listener.address.host).toBe('127.0.0.1')
		expect(listener.address.port).toBeGreaterThan(0)
	} finally {
		await listener.close()
	}
})

it.each(['https://app.test/path', 'https://user:pass@app.test', 'ftp://app.test', '', null])(
	'rejects invalid explicit publicOrigin %s before attaching a carrier',
	async (publicOrigin) => {
		const host = await createHost({ plugins: [], services: [elysia()] })
		try {
			await expect(
				Reflect.apply(listenElysia, undefined, [host, { publicOrigin }]),
			).rejects.toThrow('publicOrigin must be an HTTP(S) origin')
		} finally {
			await host.close()
		}
	},
)

it('captures the public directory before requests and keeps reserved paths outside its SPA fallback', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-listener-options-'))
	const publicDir = join(root, 'public')
	const alternative = join(root, 'alternative')
	await Promise.all([mkdir(publicDir), mkdir(alternative)])
	await Promise.all([
		writeFile(join(publicDir, 'index.html'), '<main>original</main>'),
		writeFile(join(alternative, 'index.html'), '<main>changed</main>'),
	])
	const host = await createHost({ plugins: [], services: [elysia()] })
	const options = { hostname: '127.0.0.1', port: 0, publicDir }
	try {
		for (const invalid of ['', '\0', null, 42])
			await expect(
				Reflect.apply(listenElysia, undefined, [host, { publicDir: invalid }]),
			).rejects.toThrow('publicDir must be')
		const listener = await listenElysia(host, options)
		options.publicDir = alternative
		try {
			const origin = `http://127.0.0.1:${listener.address.port}`
			const page = await fetch(`${origin}/nested/page`, { headers: { accept: 'text/html' } })
			expect(page.status).toBe(200)
			expect(await page.text()).toBe('<main>original</main>')
			for (const path of [
				'/__pluxel',
				'/__pluxel/missing',
				'/@vite/client',
				'/node_modules',
				'/node_modules/private.js',
			]) {
				const reserved = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } })
				expect(reserved.status).toBe(404)
				expect(await reserved.text()).toBe('Not Found')
			}
		} finally {
			await listener.close()
		}
	} finally {
		await host.close()
		await rm(root, { recursive: true, force: true })
	}
})

it('uses the listener owner’s selected environment snapshot', async () => {
	const environment = resolveHostEnv({
		PITCHFORK_URL: 'http://pluxel.localhost:1355',
		HOST: '127.0.0.1',
		PORT: '0',
	})
	const host = await createHost({ plugins: [], services: [elysia()] })
	const listener = await listenElysia(host, {
		hostname: environment.hostBind,
		port: environment.hostPort,
		publicOrigin: environment.publicOrigin,
	})
	try {
		expect(listener.address.host).toBe('127.0.0.1')
		expect(listener.address.port).toBeGreaterThan(0)
	} finally {
		await listener.close()
	}
})

it('exposes the trusted public origin without replacing physical listener metadata', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	resolveContextCapability(host.ctx, ElysiaRuntime).mountEndpoint({
		prefix: '/metadata',
		matchesWebSocketRoute: () => false,
		async fetch(_request, carrier) {
			return Response.json(carrier?.metadata)
		},
	})
	const listener = await listenElysia(host, {
		hostname: '127.0.0.1',
		port: 0,
		publicOrigin: 'https://app.example.test/',
	})
	try {
		const origin = `http://127.0.0.1:${listener.address.port}`
		const response = await fetch(`${origin}/metadata`, {
			headers: {
				forwarded: 'host=attacker.test;proto=https',
				'x-forwarded-host': 'attacker.test',
				'x-forwarded-proto': 'https',
			},
		})
		expect(await response.json()).toMatchObject({
			url: `${origin}/`,
			publicOrigin: 'https://app.example.test',
			hostname: '127.0.0.1',
			port: listener.address.port,
			development: false,
		})
	} finally {
		await listener.close()
	}
})

it('preserves native srvx plugins, middleware, proxy handling and Node server options', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	resolveContextCapability(host.ctx, ElysiaRuntime).mountEndpoint({
		prefix: '/native',
		matchesWebSocketRoute: () => false,
		async fetch(request) {
			return Response.json({ url: request.url })
		},
	})
	const order: string[] = []
	let native: Server | undefined
	const listener = await listenElysia(host, {
		hostname: '127.0.0.1',
		port: '0',
		trustProxy: 'loopback',
		node: { maxHeaderSize: 8192, keepAliveTimeout: 1234 },
		plugins: [
			(server) => {
				native = server
				order.push('plugin')
			},
		],
		middleware: [
			async (_request, next) => {
				order.push('before')
				const response = await next()
				response.headers.set('x-native-middleware', 'active')
				order.push('after')
				return response
			},
		],
	})
	try {
		expect(native?.node?.server).toMatchObject({ maxHeaderSize: 8192, keepAliveTimeout: 1234 })
		const response = await fetch(`http://127.0.0.1:${listener.address.port}/native`, {
			headers: { 'x-forwarded-host': 'proxy.example.test', 'x-forwarded-proto': 'https' },
		})
		expect(response.headers.get('x-native-middleware')).toBe('active')
		expect(await response.json()).toEqual({ url: 'https://proxy.example.test/native' })
		expect(order).toEqual(['plugin', 'before', 'after'])
	} finally {
		await listener.close()
	}
})

it('uses the native body limit and error handler without replacing their error contract', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	resolveContextCapability(host.ctx, ElysiaRuntime).mountEndpoint({
		prefix: '/body',
		matchesWebSocketRoute: () => false,
		async fetch(request) {
			return new Response(await request.text())
		},
	})
	const errors: unknown[] = []
	const listener = await listenElysia(host, {
		hostname: '127.0.0.1',
		port: 0,
		maxRequestBodySize: 4,
		error(error) {
			errors.push(error)
			return new Response('native limit', { status: 413 })
		},
	})
	try {
		const origin = `http://127.0.0.1:${listener.address.port}`
		const accepted = await fetch(`${origin}/body`, { method: 'POST', body: '1234' })
		expect(await accepted.text()).toBe('1234')
		const rejected = await fetch(`${origin}/body`, { method: 'POST', body: '12345' })
		expect(rejected.status).toBe(413)
		expect(await rejected.text()).toBe('native limit')
		expect(errors).toEqual([expect.objectContaining({ code: 'ERR_BODY_TOO_LARGE' })])
	} finally {
		await listener.close()
	}
})

it('rejects options that replace the managed listener lifecycle before acquiring the carrier', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	try {
		for (const key of ['fetch', 'manual', 'gracefulShutdown'])
			await expect(
				Reflect.apply(listenElysia, undefined, [host, { [key]: false }]),
			).rejects.toThrow(`listenElysia owns ${key}`)
		await expect(
			Reflect.apply(listenElysia, undefined, [host, { node: { path: '/unused.sock' } }]),
		).rejects.toThrow('requires TCP')
		const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 0 })
		await listener.close()
	} finally {
		await host.close()
	}
})
