import { once } from 'node:events'
import { createServer, type Server } from 'node:http'

import { newWebSocketRpcSession, RpcTarget, type RpcStub } from 'capnweb'
import type { Peer } from 'crossws'
import nodeWebSocketAdapter, { type NodeAdapter } from 'crossws/adapters/node'
import WebSocket from 'crossws/websocket'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	createRuntimeSessionClient,
	RUNTIME_SESSION_PATH,
	type RuntimeSessionClient,
	type RuntimeSessionEvent,
	type RuntimeSessionObserver,
} from '@pluxel/services/management/session'
import { CapnwebCrosswsWebSocket } from './support/capnweb-crossws-websocket'

class ProbeChild extends RpcTarget {
	constructor(private readonly disposed: () => void) {
		super()
	}
	value(): string {
		return 'child'
	}
	[Symbol.dispose](): void {
		this.disposed()
	}
}

class ProbeWorkbench extends RpcTarget {
	constructor(private readonly state: ProbeState) {
		super()
	}
	child(): ProbeChild {
		return new ProbeChild(() => this.state.childDisposals++)
	}
	value(): string {
		return 'workbench'
	}
	[Symbol.dispose](): void {
		this.state.workbenchDisposals++
	}
}

type ProbeState = {
	connections: number
	activeConnections: number
	bootstrapCalls: number
	managementDisposals: number
	workbenchDisposals: number
	childDisposals: number
	observer?: RpcStub<RuntimeSessionObserver>
	bootstrapGate?: Promise<void>
}

class ProbeRoot extends RpcTarget {
	constructor(private readonly state: ProbeState) {
		super()
	}
	async bootstrap(observer: RpcStub<RuntimeSessionObserver>) {
		this.state.bootstrapCalls++
		this.state.observer?.[Symbol.dispose]()
		this.state.observer = observer.dup()
		await this.state.bootstrapGate
		return {
			kind: 'workbench' as const,
			profile: 2 as const,
			management: new ProbeChild(() => this.state.managementDisposals++),
			workbench: new ProbeWorkbench(this.state),
		}
	}
	[Symbol.dispose](): void {
		this.state.observer?.[Symbol.dispose]()
		this.state.observer = undefined
	}
}

class SessionProbeServer {
	readonly state: ProbeState = {
		connections: 0,
		activeConnections: 0,
		bootstrapCalls: 0,
		managementDisposals: 0,
		workbenchDisposals: 0,
		childDisposals: 0,
	}
	private readonly httpServer: Server
	private readonly adapter: NodeAdapter
	private readonly peers = new Map<
		Peer,
		{
			socket: CapnwebCrosswsWebSocket
			root: RpcStub<RpcTarget>
		}
	>()
	constructor() {
		this.adapter = nodeWebSocketAdapter({
			idleTimeout: 0,
			hooks: {
				upgrade: (request) =>
					new URL(request.url).pathname === RUNTIME_SESSION_PATH
						? { namespace: 'runtime-client-regression' }
						: new Response('Not Found', { status: 404 }),
				open: (peer) => {
					const socket = new CapnwebCrosswsWebSocket(peer, {
						maxMessageBytes: 64 * 1024,
						maxQueuedBytes: 256 * 1024,
					})
					const root = newWebSocketRpcSession<RpcTarget>(
						socket.webSocket,
						new ProbeRoot(this.state),
					)
					this.peers.set(peer, { socket, root })
					this.state.connections++
					this.state.activeConnections++
				},
				message: (peer, message) => this.peers.get(peer)?.socket.receive(message),
				close: (peer, details) => {
					const session = this.peers.get(peer)
					if (!session) return
					this.peers.delete(peer)
					session.socket.closed(details.code, details.reason)
					session.root[Symbol.dispose]()
					this.state.activeConnections--
				},
				error: (peer, error) => this.peers.get(peer)?.socket.errored(error),
			},
		})
		this.httpServer = createServer((_request, response) => response.writeHead(404).end('Not Found'))
		this.httpServer.on('upgrade', (request, socket, head) => {
			void this.adapter.handleUpgrade(request, socket, head).catch(() => socket.destroy())
		})
	}
	async listen(): Promise<void> {
		this.httpServer.listen(0, '127.0.0.1')
		await once(this.httpServer, 'listening')
	}
	url(): string {
		const address = this.httpServer.address()
		if (!address || typeof address === 'string') throw new Error('Probe server is not listening')
		return `http://127.0.0.1:${address.port}/`
	}
	async invalidate(): Promise<void> {
		const observer = this.state.observer
		if (!observer) throw new Error('The real session observer has not been registered')
		using notification = observer({ kind: 'epoch-invalidated', cause: 'workbench' })
		try {
			await notification
		} catch {
			// The client closes its root while processing this final notification.
		}
	}
	async close(): Promise<void> {
		this.adapter.closeAll(1001, 'Test shutdown', true)
		await this.adapter.close(1001, 'Test shutdown')
		this.httpServer.closeAllConnections()
		await new Promise<void>((resolve, reject) =>
			this.httpServer.close((error) => (error ? reject(error) : resolve())),
		)
	}
}

const servers: SessionProbeServer[] = []
const clients: RuntimeSessionClient<ProbeWorkbench>[] = []
afterEach(async () => {
	for (const client of clients.splice(0)) client[Symbol.dispose]()
	await Promise.all(servers.splice(0).map((server) => server.close()))
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

async function fixture(bootstrapGate?: Promise<void>) {
	const server = new SessionProbeServer()
	server.state.bootstrapGate = bootstrapGate
	servers.push(server)
	await server.listen()
	const sockets: WebSocket[] = []
	const sends: { readyState: number; message: unknown }[] = []
	vi.stubGlobal('window', { location: { href: server.url() } })
	vi.stubGlobal(
		'WebSocket',
		class extends WebSocket {
			constructor(url: string) {
				super(url)
				sockets.push(this)
				const send = this.send.bind(this)
				vi.spyOn(this as WebSocket, 'send').mockImplementation((...args) => {
					sends.push({ readyState: this.readyState, message: args[0] })
					return send(...args)
				})
			}
		},
	)
	const client = createRuntimeSessionClient<ProbeWorkbench>()
	clients.push(client)
	return { server, client, sockets, sends }
}

describe('Runtime session client over native Capnweb and WebSocket', () => {
	it('replaces an accepted bootstrap graph without closing the socket and disposes both generations exactly once', async () => {
		const { server, client, sends } = await fixture()
		const first = await client.bootstrap(() => {})
		if (first.kind !== 'workbench') throw new Error('Expected the native Workbench capability')
		await expect(first.workbench.value()).resolves.toBe('workbench')
		const second = await client.bootstrap(() => {})
		if (second.kind !== 'workbench') throw new Error('Expected the native Workbench capability')
		expect(client.current).toBe(second)
		await expect(second.workbench.value()).resolves.toBe('workbench')
		await expect(Promise.resolve().then(() => first.workbench.value())).rejects.toThrow(/disposed/i)
		await vi.waitFor(() => expect(server.state.workbenchDisposals).toBe(1))
		expect(server.state.managementDisposals).toBe(1)
		expect(server.state.activeConnections).toBe(1)
		expect(server.state.connections).toBe(1)
		client[Symbol.dispose]()
		client[Symbol.dispose]()
		await vi.waitFor(() => expect(server.state.activeConnections).toBe(0))
		expect(server.state.managementDisposals).toBe(2)
		expect(server.state.workbenchDisposals).toBe(2)
		expect(sends.filter((send) => send.readyState >= WebSocket.CLOSING)).toEqual([])
	})

	it('shuts down the Capnweb root before releasing the bootstrap graph during the real WebSocket CLOSING window', async () => {
		const { server, client, sockets, sends } = await fixture()
		const bootstrap = await client.bootstrap(() => {})
		expect(bootstrap.kind).toBe('workbench')
		const socket = sockets[0]
		if (!socket) throw new Error('The real WebSocket has not been constructed')
		socket.close()
		expect(socket.readyState).toBe(WebSocket.CLOSING)
		client[Symbol.dispose]()
		client[Symbol.dispose]()
		expect(client.current).toBeUndefined()
		expect(sends.filter((send) => send.readyState >= WebSocket.CLOSING)).toEqual([])
		await expect(client.bootstrap(() => {})).rejects.toThrow('disposed')
		await vi.waitFor(() => expect(server.state.activeConnections).toBe(0))
		expect(server.state.connections).toBe(1)
		expect(server.state.managementDisposals).toBe(1)
		expect(server.state.workbenchDisposals).toBe(1)
	})

	it('revokes the root and owned graph before the epoch observer releases borrowed plugin resources', async () => {
		const { server, client, sends } = await fixture()
		const observed: { event: RuntimeSessionEvent; current: unknown }[] = []
		let child!: RpcStub<ProbeChild>
		const bootstrap = await client.bootstrap((event) => {
			observed.push({ event, current: client.current })
			child[Symbol.dispose]()
		})
		if (bootstrap.kind !== 'workbench') throw new Error('Expected the native Workbench capability')
		child = await bootstrap.workbench.child()
		await expect(child.value()).resolves.toBe('child')
		const sendCount = sends.length
		await server.invalidate()
		expect(observed).toEqual([
			{ event: { kind: 'epoch-invalidated', cause: 'workbench' }, current: undefined },
		])
		expect(sends.slice(sendCount)).toEqual([])
		expect(client.current).toBeUndefined()
		await expect(client.bootstrap(() => {})).rejects.toThrow('disposed')
		await expect(client.logout()).rejects.toThrow('disposed')
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		await expect(client.commitCookie('after-epoch')).rejects.toThrow('disposed')
		expect(fetch).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(server.state.activeConnections).toBe(0))
		expect(server.state.managementDisposals).toBe(1)
		expect(server.state.workbenchDisposals).toBe(1)
		expect(server.state.childDisposals).toBe(1)
	})

	it('rejects an in-flight bootstrap after epoch invalidation and never accepts its late result', async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const { server, client } = await fixture(gate)
		const observer = vi.fn()
		const outcome = client.bootstrap(observer).then(
			(value) => ({ kind: 'accepted' as const, value }),
			(error) => ({ kind: 'rejected' as const, error }),
		)
		await vi.waitFor(() => expect(server.state.bootstrapCalls).toBe(1))
		await server.invalidate()
		release()
		expect(await outcome).toMatchObject({ kind: 'rejected', error: expect.any(Error) })
		expect(client.current).toBeUndefined()
		expect(observer).toHaveBeenCalledOnce()
		await vi.waitFor(() => expect(server.state.activeConnections).toBe(0))
	})
})
