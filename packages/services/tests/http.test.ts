import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import { createHost } from '@pluxel/host'
import { expect, it } from 'vitest'
import { ElysiaApp, elysia } from '../src/elysia'
import { ElysiaRuntime } from '@pluxel/services/internal'

@Plugin()
class Routes extends BasePlugin {
	init() {
		this.ctx.require(ElysiaApp).get('/hello', () => 'hello')
	}
}
@Plugin()
class ConflictingRoutes extends BasePlugin {
	init() {
		this.ctx.require(ElysiaApp).get('/hello', () => 'conflict')
	}
}

it('publishes and withdraws business routes through the standalone Host commit without management', async () => {
	const host = await createHost({ plugins: [Routes, ConflictingRoutes], services: [elysia()] })
	try {
		const server = resolveContextCapability(host.ctx, ElysiaRuntime)
		const request = () => new Request('http://localhost/hello')
		const absent = await server.fetch(request())
		expect(absent.status).toBe(404)
		await host.startNode(pluginNodeAddressOf(Routes))
		const published = await server.fetch(request())
		expect(await published.text()).toBe('hello')
		await host.startNode(pluginNodeAddressOf(ConflictingRoutes))
		const conflict = await server.fetch(request())
		expect(await conflict.text()).toBe('hello')
		expect('adminAccess' in host.ctx).toBe(false)
		expect('workbench' in host.ctx).toBe(false)
		await host.stopNode(pluginNodeAddressOf(ConflictingRoutes))
		await host.stopNode(pluginNodeAddressOf(Routes))
		const withdrawn = await server.fetch(request())
		expect(withdrawn.status).toBe(404)
	} finally {
		await host.close()
	}
})

it('aborts admitted endpoints on Host close and preserves carrier ingress identity', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	const server = resolveContextCapability(host.ctx, ElysiaRuntime)
	const ingress = new Request('http://localhost/endpoint', { method: 'POST', body: 'payload' })
	let received!: Request
	let release!: () => void
	const started = new Promise<void>((resolve) => {
		release = resolve
	})
	const metadata = {
		url: new URL('http://localhost'),
		port: 80,
		hostname: 'localhost',
		development: true,
	}
	const address = { address: '127.0.0.1', port: 1234, family: 'IPv4' as const }
	let upgraded = false
	server.attachApplicationCarrier({
		metadata,
		requestIP: (request) => {
			expect(request).toBe(ingress)
			return address
		},
		upgrade: (input) => {
			expect(input.request).toBe(ingress)
			expect(input.upgradeRequest).toBe(received)
			upgraded = true
			return false
		},
		publish: () => 0,
		pending: () => 0,
	})
	server.mountEndpoint({
		prefix: '/endpoint',
		matchesWebSocketRoute: () => false,
		async fetch(request, carrier) {
			received = request
			expect(await request.text()).toBe('payload')
			expect(carrier?.metadata).toBe(metadata)
			expect(carrier?.requestIP(request)).toBe(address)
			carrier?.upgrade({
				request,
				upgradeRequest: request,
				ownerKey: 'test',
				signal: request.signal,
				release() {},
				data: {},
			})
			const aborted = new Promise<void>((resolve) =>
				request.signal.addEventListener('abort', () => resolve(), { once: true }),
			)
			release()
			await aborted
			return new Response('stopped')
		},
	})
	try {
		const response = server.fetch(ingress)
		await started
		await host.close()
		expect(received.signal.aborted).toBe(true)
		expect(ingress.signal.aborted).toBe(false)
		expect(upgraded).toBe(true)
		const settled = await response
		expect(await settled.text()).toBe('stopped')
	} finally {
		await host.close()
	}
})

it('forwards client abort to an admitted endpoint', async () => {
	const host = await createHost({ plugins: [], services: [elysia()] })
	const server = resolveContextCapability(host.ctx, ElysiaRuntime)
	const abort = new AbortController()
	let received!: AbortSignal
	server.mountEndpoint({
		prefix: '/endpoint',
		matchesWebSocketRoute: () => false,
		async fetch(request) {
			received = request.signal
			return new Response('ok')
		},
	})
	try {
		await server.fetch(new Request('http://localhost/endpoint', { signal: abort.signal }))
		abort.abort('client disconnected')
		expect(received.aborted).toBe(true)
		expect(received.reason).toBe('client disconnected')
	} finally {
		await host.close()
	}
})
