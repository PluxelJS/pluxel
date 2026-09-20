import { http, HttpServer } from '@pluxel/services/http'
import { NodeElysiaApplicationCarrier } from '@pluxel/services/http/node'
import { managementHttp } from '../../src/management/http'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import NodeWebSocket from 'crossws/websocket'
import nodeAdapter from 'crossws/adapters/node'
import { getWebSocketHooks, setWebSocketHooks } from 'crossws'
import { newWebSocketRpcSession } from 'capnweb'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { persistence } from '@pluxel/services/persistence'
import { resolveContextCapability } from '@pluxel/core/host'
import { expect, it, vi } from 'vitest'
import { requirePluginHostCoordinator } from '@pluxel/host/internal'
import { RuntimeManagementTargetImpl } from '../../src/management/services/management/RuntimeManagementTarget'
import { managementAccess, AdminAccess } from '../../src/management/access'
import { management, createHostManagementTarget } from '../../src/management/service'
import { createManagementEndpoint } from '../../src/management/index'
import { createRuntimeManagementClient } from '../../src/management/client'
import type { RuntimeSessionRoot } from '../../src/management/web/session/protocol'

// Crossws forwards the third argument to ws on Node, although its declaration only exposes WebSocket.
const HeaderWebSocket = NodeWebSocket as typeof NodeWebSocket & {
	new (url: string, protocols: string[], options: { headers: Record<string, string> }): WebSocket
}

@Plugin({ displayName: 'Managed worker' })
class ManagedWorker extends BasePlugin {}

it('serves a real authenticated socket for a Core Host and leaves it alive when the endpoint closes', async () => {
	const host = await createHost({
		plugins: [ManagedWorker],
		services: [persistence({ mode: 'memory' }), managementAccess(), management()],
	})
	await host.start()
	const endpoint = createManagementEndpoint({
		authentication: resolveContextCapability(host.ctx, AdminAccess),
		createManagement: (session) => createHostManagementTarget(host.ctx, session),
		onError: (error) => {
			throw error
		},
	})
	const server = createServer((_request, response) => response.writeHead(404).end())
	const sockets = nodeAdapter({ resolve: getWebSocketHooks })
	let upgrades = 0
	let origin = ''
	server.on('upgrade', (request, socket, head) => {
		const headers = new Headers()
		for (const [key, value] of Object.entries(request.headers))
			if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
		const webRequest = new Request(origin + request.url, { headers })
		const prepared = endpoint.prepareUpgrade(webRequest, {
			address: request.socket.remoteAddress,
			secure: false,
			origin,
		})
		if (prepared.accepted === false) {
			socket.destroy()
			return
		}

		const connection = prepared.connection
		setWebSocketHooks(webRequest, {
			open: (peer) => {
				upgrades++
				return connection.open({
					readyState: 1,
					send: (message) => {
						peer.send(message)
						return peer.bufferedAmount === 0
					},
					close: (code, reason) => peer.close(code, reason),
				})
			},
			message: (_peer, message) => connection.receive(message.text()),
			close: (_peer, details) => {
				connection.transportClosed(details.code, details.reason)
				connection.release()
			},
		})
		void sockets.handleUpgrade(request, socket, head, webRequest).catch(() => {
			connection.release()
			socket.destroy()
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
	const socket = new HeaderWebSocket(
		origin.replace('http:', 'ws:') + '/__pluxel/runtime/session',
		[],
		{ headers: { origin } },
	)
	const root = newWebSocketRpcSession<RuntimeSessionRoot>(socket as unknown as WebSocket)
	try {
		const boot = await root.bootstrap(async () => {})
		expect(boot.kind).toBe('management')
		if (boot.kind !== 'management') throw new Error('Expected authenticated management')
		const client = createRuntimeManagementClient(boot.management)
		expect(await client.describe()).toMatchObject({ workbench: { enabled: false } })
		expect(await client.catalog.snapshot()).toMatchObject({ summary: { total: 1, running: 0 } })
		const address = pluginNodeAddressOf(ManagedWorker)
		const started = await client.plugins.applyLifecycleCommands([{ address, command: 'start' }])
		expect(started.ok).toBe(true)
		expect(await host.status()).toMatchObject({ statuses: [{ lifecycleState: 'running' }] })
		expect(upgrades).toBe(1)
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const blocker = requirePluginHostCoordinator(host.ctx).runExclusive(
			'test-admission',
			async () => {
				entered.resolve()
				await release.promise
			},
		)
		await entered.promise
		const calls = vi.spyOn(RuntimeManagementTargetImpl.prototype, 'applyPluginLifecycleCommands')
		const queued = client.plugins.applyLifecycleCommands([{ address, command: 'stop' }])
		const outcome = queued.then(
			(): undefined => undefined,
			(error: unknown) => error,
		)
		await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce())
		const closed = once(socket, 'close')
		endpoint.close()
		await closed
		expect(await outcome).toBeInstanceOf(Error)
		expect(String(await outcome)).toMatch(/closed|active|disposed|socket/i)
		release.resolve()
		await blocker
		calls.mockRestore()
		expect(await host.status()).toMatchObject({ statuses: [{ lifecycleState: 'running' }] })
		await host.stopNode(address)
		expect(await host.status()).toMatchObject({ statuses: [{ lifecycleState: 'stopped' }] })
		boot[Symbol.dispose]()
	} finally {
		endpoint.close()
		root[Symbol.dispose]()
		socket.close()
		sockets.closeAll(1001, 'test complete', true)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
		await host.close()
	}
})

it('mounts management through the selected Host HTTP carrier and withdraws it on Host close', async () => {
	const host = await createHost({
		plugins: [ManagedWorker],
		services: [
			http(),
			persistence({ mode: 'memory' }),
			managementAccess(),
			management(),
			managementHttp(),
		],
	})
	await host.start()
	const boundary = resolveContextCapability(host.ctx, HttpServer)
	const unmountShell = boundary.mountFallback({
		matchesRequest: (request) => new URL(request.url).pathname === '/shell',
		fetch: async (request) =>
			new URL(request.url).pathname === '/shell' ? new Response('shell') : null,
	})
	const { fetch: fetchHost } = boundary
	const shellResponse = await fetchHost(new Request('http://host.test/shell'))
	expect(await shellResponse.text()).toBe('shell')
	expect(await fetchHost(new Request('http://host.test/missing'))).toMatchObject({ status: 404 })
	unmountShell()
	unmountShell()
	expect(await fetchHost(new Request('http://host.test/shell'))).toMatchObject({ status: 404 })
	const server = createServer((_request, response) => response.writeHead(404).end())
	let origin = ''
	const carrier = new NodeElysiaApplicationCarrier({
		fetch: boundary.fetch.bind(boundary),
		matches: boundary.matchesWebSocketRoute.bind(boundary),
		metadata: () => ({
			url: new URL(origin),
			hostname: '127.0.0.1',
			port: (server.address() as AddressInfo).port,
			development: false,
		}),
	})
	const detach = boundary.attachApplicationCarrier(carrier)
	server.on('upgrade', (request, socket, head) => carrier.handleUpgrade(request, socket, head))
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
	const socket = new HeaderWebSocket(
		origin.replace('http:', 'ws:') + '/__pluxel/runtime/session',
		[],
		{ headers: { origin } },
	)
	await once(socket, 'open')
	const root = newWebSocketRpcSession<RuntimeSessionRoot>(socket as unknown as WebSocket)
	try {
		const boot = await root.bootstrap(async () => {})
		if (boot.kind !== 'management') throw new Error('Expected loopback session')
		const client = createRuntimeManagementClient(boot.management)
		expect(await client.catalog.snapshot()).toMatchObject({ summary: { total: 1 } })
		boot[Symbol.dispose]()
		const closed = once(socket, 'close')
		await host.close()
		await closed
		expect(await boundary.fetch(new Request(origin + '/__pluxel/runtime/session'))).toMatchObject({
			status: 503,
		})
		expect(boundary.matchesWebSocketRoute(new Request(origin + '/__pluxel/runtime/session'))).toBe(
			false,
		)
	} finally {
		root[Symbol.dispose]()
		detach()
		await carrier.close()
		await host.close()
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
	}
})
