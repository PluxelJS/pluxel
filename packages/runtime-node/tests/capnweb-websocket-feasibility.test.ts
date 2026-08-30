import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { newWebSocketRpcSession, RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'
import type { Peer } from 'crossws'
import nodeWebSocketAdapter, { type NodeAdapter } from 'crossws/adapters/node'
import WebSocket from 'crossws/websocket'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	CapnwebCrosswsWebSocket,
	type CapnwebCrosswsLimitViolation,
} from './support/capnweb-crossws-websocket'

const TEST_TIMEOUT_MS = 5_000
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024

type Observer = (value: string) => void

interface ProbeChildApi extends RpcTarget {
	value(): string
}

interface ProbeApi extends RpcTarget {
	ping(value: string): string
	callObserver(observer: Observer): Promise<void>
	child(): ProbeChildApi
	wait(): Promise<string>
}

interface ProbeState {
	connectionsOpened: number
	activeConnections: number
	pingCalls: number
	callbackCalls: number
	retainedCallbacks: number
	childDisposals: number
	waitCalls: number
	closeEvents: Array<{ code: number; reason: string }>
	limitViolations: CapnwebCrosswsLimitViolation[]
}

class ProbeChild extends RpcTarget {
	constructor(private readonly state: ProbeState) {
		super()
	}

	value(): string {
		return 'child-value'
	}

	[Symbol.dispose](): void {
		this.state.childDisposals++
	}
}

class ProbeRoot extends RpcTarget {
	constructor(private readonly state: ProbeState) {
		super()
	}

	ping(value: string): string {
		this.state.pingCalls++
		return `pong:${value}`
	}

	async callObserver(observer: RpcStub<Observer>): Promise<void> {
		const retained = observer.dup()
		this.state.retainedCallbacks++
		await Promise.resolve()
		try {
			await retained('from-server')
			this.state.callbackCalls++
		} finally {
			retained[Symbol.dispose]()
			this.state.retainedCallbacks--
		}
	}

	child(): ProbeChildApi {
		return new ProbeChild(this.state)
	}

	wait(): Promise<string> {
		this.state.waitCalls++
		return new Promise(() => undefined)
	}
}

class CrosswsCapnwebProbeServer {
	readonly state: ProbeState = {
		connectionsOpened: 0,
		activeConnections: 0,
		pingCalls: 0,
		callbackCalls: 0,
		retainedCallbacks: 0,
		childDisposals: 0,
		waitCalls: 0,
		closeEvents: [],
		limitViolations: [],
	}

	private readonly httpServer: Server
	private readonly sessions = new Map<
		Peer,
		{ socket: CapnwebCrosswsWebSocket; remoteRoot: RpcStub<RpcTarget> }
	>()
	private readonly adapter: NodeAdapter
	private activePeer?: Peer
	private listening = false

	constructor(maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {
		this.adapter = nodeWebSocketAdapter({
			idleTimeout: 0,
			// crossws/ws can reject oversized frames during parsing. The smaller
			// Cap'n Web adapter limit below proves the application-message seam too.
			serverOptions: { maxPayload: DEFAULT_MAX_MESSAGE_BYTES * 2 },
			hooks: {
				upgrade: (request) =>
					new URL(request.url).pathname === '/capnweb'
						? { namespace: 'capnweb-feasibility' }
						: new Response('Not Found', { status: 404 }),
				open: (peer) => {
					const socket = new CapnwebCrosswsWebSocket(peer, {
						maxMessageBytes,
						maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
						onLimitViolation: (violation) => this.state.limitViolations.push(violation),
					})
					const remoteRoot = newWebSocketRpcSession<RpcTarget>(
						socket.webSocket,
						new ProbeRoot(this.state),
					)
					this.sessions.set(peer, { socket, remoteRoot })
					this.activePeer = peer
					this.state.connectionsOpened++
					this.state.activeConnections++
				},
				message: (peer, message) => this.sessions.get(peer)?.socket.receive(message),
				close: (peer, details) => {
					const session = this.sessions.get(peer)
					if (!session) return
					this.sessions.delete(peer)
					session.socket.closed(details.code, details.reason)
					this.state.activeConnections--
					this.state.closeEvents.push({ code: details.code ?? 1000, reason: details.reason ?? '' })
					if (this.activePeer === peer) this.activePeer = undefined
				},
				error: (peer, error) => this.sessions.get(peer)?.socket.errored(error),
			},
		})

		this.httpServer = createServer((_request, response) => {
			response.writeHead(404).end('Not Found')
		})
		this.httpServer.on('upgrade', (request, socket, head) => {
			void this.adapter.handleUpgrade(request, socket, head).catch(() => socket.destroy())
		})
	}

	async listen(): Promise<void> {
		this.httpServer.listen(0, '127.0.0.1')
		await once(this.httpServer, 'listening')
		this.listening = true
	}

	url(): string {
		const address = this.httpServer.address() as AddressInfo
		return `ws://127.0.0.1:${address.port}/capnweb`
	}

	terminateActivePeer(): void {
		if (!this.activePeer) throw new Error('No active crossws peer')
		this.activePeer.terminate()
	}

	async close(): Promise<void> {
		if (!this.listening) return
		this.adapter.closeAll(1001, 'Test shutdown', true)
		await this.adapter.close(1001, 'Test shutdown')
		this.httpServer.closeAllConnections()
		await new Promise<void>((resolve, reject) => {
			this.httpServer.close((error) => {
				if (error) {
					reject(error)
					return
				}
				resolve()
			})
		})
		this.listening = false
	}
}

const servers: CrosswsCapnwebProbeServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("Cap'n Web 0.5 over a real Node/crossws WebSocket", () => {
	it('uses one physical socket for repeated RPC, callbacks, and disposable child targets', async () => {
		const server = await startServer()
		const api = connect(server)

		await expect(
			Promise.all(['one', 'two', 'three'].map(async (value) => api.ping(value))),
		).resolves.toEqual(['pong:one', 'pong:two', 'pong:three'])
		expect(server.state.connectionsOpened).toBe(1)
		expect(server.state.activeConnections).toBe(1)
		expect(server.state.pingCalls).toBe(3)

		const observed: string[] = []
		await api.callObserver((value) => observed.push(value))
		expect(observed).toEqual(['from-server'])
		expect(server.state.callbackCalls).toBe(1)
		expect(server.state.retainedCallbacks).toBe(0)

		const child = await api.child()
		await expect(child.value()).resolves.toBe('child-value')
		child[Symbol.dispose]()
		await eventually(() => server.state.childDisposals === 1)

		api[Symbol.dispose]()
		await eventually(() => server.state.activeConnections === 0)
		expect(server.state.connectionsOpened).toBe(1)
	})

	it('breaks pending and future root calls when the physical socket dies', async () => {
		const server = await startServer()
		const api = connect(server)
		const broken = deferred<unknown>()
		api.onRpcBroken((error) => broken.resolve(error))

		await expect(api.ping('ready')).resolves.toBe('pong:ready')
		const pending = api.wait()
		await eventually(() => server.state.waitCalls === 1)
		server.terminateActivePeer()

		await expect(withTimeout(pending)).rejects.toThrow(/.+/)
		await expect(withTimeout(broken.promise)).resolves.toBeInstanceOf(Error)
		await expect(Promise.resolve().then(() => api.ping('late'))).rejects.toThrow(/.+/)
		pending[Symbol.dispose]()
		api[Symbol.dispose]()
		await eventually(() => server.state.activeConnections === 0)
	})

	it('closes the physical socket when the root stub is disposed', async () => {
		const server = await startServer()
		const api = connect(server)

		await expect(api.ping('ready')).resolves.toBe('pong:ready')
		api[Symbol.dispose]()

		await eventually(() => server.state.activeConnections === 0)
		expect(server.state.closeEvents).toHaveLength(1)
	})

	it("can reject oversized encoded RPC messages before Cap'n Web dispatch", async () => {
		const server = await startServer(1_024)
		const api = connect(server)

		await expect(api.ping('ready')).resolves.toBe('pong:ready')
		await expect(api.ping('x'.repeat(16 * 1024))).rejects.toThrow(/.+/)
		await eventually(() => server.state.activeConnections === 0)

		expect(server.state.limitViolations).toEqual([
			expect.objectContaining({
				kind: 'inbound-message-bytes',
				limitBytes: 1_024,
			}),
		])
		expect(server.state.closeEvents[0]?.code).toBe(1009)
		api[Symbol.dispose]()
	})

	it('places a conservative queued-byte ceiling before crossws peer.send()', () => {
		const peer = {
			websocket: { readyState: WebSocket.OPEN },
			bufferedAmount: 48,
			send: vi.fn(),
			close: vi.fn(),
		} as unknown as Peer
		const violations: CapnwebCrosswsLimitViolation[] = []
		const socket = new CapnwebCrosswsWebSocket(peer, {
			maxMessageBytes: 1_024,
			maxQueuedBytes: 64,
			onLimitViolation: (violation) => violations.push(violation),
		})

		expect(() => socket.webSocket.send('x'.repeat(17))).toThrow(/queue exceeds/)
		expect(peer.send).not.toHaveBeenCalled()
		expect(peer.close).toHaveBeenCalledWith(1009, 'outbound-queued-bytes exceeded')
		expect(violations).toEqual([{ kind: 'outbound-queued-bytes', actualBytes: 65, limitBytes: 64 }])
	})
})

function connect(server: CrosswsCapnwebProbeServer): RpcStub<ProbeApi> {
	return newWebSocketRpcSession<ProbeApi>(new WebSocket(server.url()) as WebSocket)
}

async function startServer(maxMessageBytes?: number): Promise<CrosswsCapnwebProbeServer> {
	const server = new CrosswsCapnwebProbeServer(maxMessageBytes)
	servers.push(server)
	await server.listen()
	return server
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve
	})
	return { promise, resolve }
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for probe state')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error('Timed out waiting for RPC result')),
				TEST_TIMEOUT_MS,
			)
			timer.unref?.()
		}),
	])
}
