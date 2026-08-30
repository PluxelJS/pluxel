import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	createWorkbenchFederationDeploymentInventory,
} from '@pluxel/core/federation'
import {
	type ManagementAccessProvider,
	type ManagementAuthenticationProviderSession,
} from '@pluxel/runtime'
import { newWebSocketRpcSession, type RpcStub } from '@pluxel/runtime/capnweb'
import { type ElysiaApplicationCarrier, requireRuntimeHttpService } from '@pluxel/runtime/internal'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import {
	RUNTIME_SESSION_PATH,
	type RuntimeSessionEvent,
	type RuntimeSessionObserver,
	type RuntimeSessionRoot,
} from '@pluxel/runtime/web/session'
import { workbench } from '@pluxel/runtime/workbench'
import { createDiskFixture } from '@pluxel/test/fixtures'
import NodeWebSocket from 'crossws/websocket'
import { afterEach, describe, expect, it } from 'vitest'

import { NodeElysiaApplicationCarrier } from '@pluxel/runtime-node'
import { defineStaticRuntime } from '@pluxel/runtime-static'

import { runStaticNodeWorkbenchApplication } from '../src/internal/node-workbench-application'

const TEST_TIMEOUT_MS = 5_000
const CONTROL_OWNER = 'pluxel.runtime.control'
const REMOTE_ADDRESS = Object.freeze({
	address: '203.0.113.9',
	port: 45_000,
	family: 'IPv4' as const,
})

let authenticationSessionsOpened = 0
let authenticationSessionsDisposed = 0
let authenticationOpenBarrier: PromiseWithResolvers<void> | undefined

class TestAuthenticationSession implements ManagementAuthenticationProviderSession {
	private active = true
	private authenticated = false

	constructor() {
		authenticationSessionsOpened++
	}

	state() {
		return this.authenticated
			? Object.freeze({
					kind: 'authenticated' as const,
					principal: Object.freeze({ subject: 'test-user', displayName: 'Test User' }),
				})
			: Object.freeze({
					kind: 'challenge' as const,
					challenge: Object.freeze({ kind: 'password' as const, label: 'Test password' }),
				})
	}

	submit(input: unknown) {
		if (!this.active)
			return Object.freeze({ kind: 'failed' as const, code: 'authentication_expired' as const })
		if (
			!input ||
			typeof input !== 'object' ||
			Array.isArray(input) ||
			(input as { password?: unknown }).password !== 'correct'
		) {
			return Object.freeze({ kind: 'failed' as const, code: 'authentication_failed' as const })
		}
		this.authenticated = true
		return this.state()
	}

	[Symbol.dispose](): void {
		if (!this.active) return
		this.active = false
		authenticationSessionsDisposed++
	}
}

@Plugin({ displayName: 'Runtime session test authentication' })
class RuntimeSessionAuthentication extends BasePlugin {
	private readonly provider: ManagementAccessProvider = Object.freeze({
		status: () =>
			Object.freeze({
				id: 'runtime-session-test',
				label: 'Runtime session test',
				method: 'password' as const,
				ready: true,
			}),
		open: async () => {
			await authenticationOpenBarrier?.promise
			return new TestAuthenticationSession()
		},
	})

	protected override init(): void {
		this.ctx.managementAccess?.provide(this.provider)
	}
}

const EmptyWorkbenchPublication = workbench.define({})

@Plugin({ displayName: 'Runtime session test publication' })
class RuntimeSessionPublication extends BasePlugin {
	protected override init(): void {
		this.ctx.workbench?.publish(EmptyWorkbenchPublication, {})
	}
}

class RuntimeSessionNodeHarness {
	readonly host: RuntimeHost
	readonly nodeCarrier: NodeElysiaApplicationCarrier
	readonly server: Server
	upgradeCount = 0

	private detachCarrier: (() => void) | undefined
	private listening = false

	constructor() {
		this.host = createRuntimeHost({ management: {}, workbench: { enabled: true } })
		const http = requireRuntimeHttpService(this.host.ctx)
		this.nodeCarrier = new NodeElysiaApplicationCarrier({
			fetch: (request) => this.host.fetch(request),
			matches: (request) => http.matchesWebSocketRoute(request),
			metadata: () => {
				const address = this.server.address() as AddressInfo
				const url = new URL(`https://127.0.0.1:${address.port}/`)
				return Object.freeze({
					url,
					port: address.port,
					hostname: '127.0.0.1',
					development: false,
				})
			},
		})
		const thisNodeCarrier = this.nodeCarrier
		const trustedCarrier: ElysiaApplicationCarrier = {
			get metadata() {
				return thisNodeCarrier.metadata
			},
			upgrade: (input) => this.nodeCarrier.upgrade(input),
			publish: (ownerKey, topic, data, compress) =>
				this.nodeCarrier.publish(ownerKey, topic, data, compress),
			pending: (ownerKey) => this.nodeCarrier.pending(ownerKey),
			requestIP: () => REMOTE_ADDRESS,
		}
		this.detachCarrier = http.attachApplicationCarrier(trustedCarrier)
		this.server = createServer((_request, response) => response.writeHead(404).end('Not Found'))
		this.server.on('upgrade', (request, socket, head) => {
			if (!this.nodeCarrier.matchesUpgrade(request)) {
				socket.destroy()
				return
			}
			this.upgradeCount++
			this.nodeCarrier.handleUpgrade(request, socket, head)
		})
	}

	async start(): Promise<void> {
		this.host.add([RuntimeSessionAuthentication, RuntimeSessionPublication])
		this.host.start(RuntimeSessionAuthentication)
		this.host.start(RuntimeSessionPublication)
		await this.host.commit()
		this.server.listen(0, '127.0.0.1')
		await once(this.server, 'listening')
		this.listening = true
	}

	connect(): Readonly<{ socket: WebSocket; root: RpcStub<RuntimeSessionRoot> }> {
		const address = this.server.address() as AddressInfo
		const origin = `https://127.0.0.1:${address.port}`
		const WebSocketConstructor = NodeWebSocket as unknown as new (
			url: string,
			protocols: string[],
			options: { headers: Record<string, string> },
		) => WebSocket
		const socket = new WebSocketConstructor(
			`ws://127.0.0.1:${address.port}${RUNTIME_SESSION_PATH}`,
			[],
			{ headers: { origin } },
		)
		return Object.freeze({
			socket,
			root: newWebSocketRpcSession<RuntimeSessionRoot>(socket),
		})
	}

	detach(): void {
		this.detachCarrier?.()
		this.detachCarrier = undefined
	}

	async close(): Promise<void> {
		this.detach()
		await this.nodeCarrier.close().catch((): undefined => undefined)
		if (this.listening) {
			this.server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				this.server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
			this.listening = false
		}
		await this.host.dispose()
	}
}

const harnesses: RuntimeSessionNodeHarness[] = []

afterEach(async () => {
	authenticationOpenBarrier?.resolve()
	authenticationOpenBarrier = undefined
	await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

describe('Runtime Session over the production Node carrier', () => {
	it('keeps authentication and ready capabilities on one socket and drains every epoch', async () => {
		authenticationSessionsOpened = 0
		authenticationSessionsDisposed = 0
		const harness = new RuntimeSessionNodeHarness()
		harnesses.push(harness)
		await harness.start()

		const first = harness.connect()
		await withTimeout(waitForOpen(first.socket), 'first socket open')
		const firstInvalidation = Promise.withResolvers<RuntimeSessionEvent>()
		const observer: RuntimeSessionObserver = (event) =>
			firstInvalidation.resolve(Object.freeze({ ...event }))

		const challenge = await withTimeout(first.root.bootstrap(observer), 'first bootstrap')
		try {
			expect(challenge).toMatchObject({ kind: 'authentication-required', profile: 1 })
			if (challenge.kind !== 'authentication-required') throw new Error('challenge missing')
			const step = await challenge.authentication.submit({ password: 'correct' })
			try {
				expect(step).toMatchObject({
					kind: 'authenticated',
					principal: { subject: 'test-user' },
				})
			} finally {
				disposeRpcValue(step)
			}
		} finally {
			disposeRpcValue(challenge)
		}

		const ready = await first.root.bootstrap(observer)
		try {
			expect(ready).toMatchObject({ kind: 'workbench', profile: 1 })
			if (ready.kind !== 'workbench') throw new Error('ready capabilities missing')
			const management = await ready.management.describe()
			const layout = await ready.workbench.layout({ target: null })
			try {
				expect(management).toMatchObject({
					protocol: { name: 'pluxel.management', major: 1 },
					workbench: { enabled: true },
				})
				expect(layout).toMatchObject({ profile: 1, target: null, entries: [] })
			} finally {
				disposeRpcValue(management)
				disposeRpcValue(layout)
			}
		} finally {
			disposeRpcValue(ready)
		}

		expect(harness.upgradeCount).toBe(1)
		expect(harness.nodeCarrier.pending(CONTROL_OWNER)).toBe(1)
		const firstClosed = waitForClose(first.socket)
		harness.host.stop(RuntimeSessionPublication)
		await harness.host.commit()
		await expect(withTimeout(firstInvalidation.promise)).resolves.toEqual({
			kind: 'epoch-invalidated',
			cause: 'workbench',
		})
		await expect(withTimeout(firstClosed)).resolves.toMatchObject({ code: 1012 })
		await eventually(() => harness.nodeCarrier.pending(CONTROL_OWNER) === 0)
		await eventually(() => authenticationSessionsDisposed === 1)
		first.root[Symbol.dispose]()

		const disconnected = harness.connect()
		await withTimeout(waitForOpen(disconnected.socket))
		await authenticate(disconnected.root, () => undefined)
		disconnected.root[Symbol.dispose]()
		await eventually(() => harness.nodeCarrier.pending(CONTROL_OWNER) === 0)
		await eventually(() => authenticationSessionsDisposed === 2)

		const restarted = harness.connect()
		await withTimeout(waitForOpen(restarted.socket))
		const serviceInvalidation = Promise.withResolvers<RuntimeSessionEvent>()
		await authenticate(restarted.root, (event) =>
			serviceInvalidation.resolve(Object.freeze({ ...event })),
		)
		const restartedClosed = waitForClose(restarted.socket)
		harness.detach()
		await expect(withTimeout(serviceInvalidation.promise)).resolves.toEqual({
			kind: 'epoch-invalidated',
			cause: 'service-restart',
		})
		await expect(withTimeout(restartedClosed)).resolves.toMatchObject({ code: 1012 })
		await eventually(() => harness.nodeCarrier.pending(CONTROL_OWNER) === 0)
		await eventually(() => authenticationSessionsDisposed === 3)
		expect(authenticationSessionsOpened).toBe(3)
		restarted.root[Symbol.dispose]()
	}, 20_000)

	it('replays the first RPC frame after asynchronous authentication session setup', async () => {
		authenticationOpenBarrier = Promise.withResolvers<void>()
		const harness = new RuntimeSessionNodeHarness()
		harnesses.push(harness)
		await harness.start()

		const connection = harness.connect()
		await withTimeout(waitForOpen(connection.socket))
		const challengePromise = connection.root.bootstrap(() => undefined)
		await Promise.resolve()
		authenticationOpenBarrier.resolve()

		const challenge = await withTimeout(challengePromise, 'buffered bootstrap')
		try {
			expect(challenge).toMatchObject({ kind: 'authentication-required', profile: 1 })
		} finally {
			disposeRpcValue(challenge)
			connection.root[Symbol.dispose]()
		}
	}, 10_000)

	it('serves the control session from the production static launcher and invalidates it on stop', async () => {
		const inventory = createWorkbenchFederationDeploymentInventory([])
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(inventory)}\n`,
			},
		})
		const runtime = await runStaticNodeWorkbenchApplication(
			defineStaticRuntime({
				name: 'runtime-session-static-launcher',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
					workbench: { enabled: true },
				}),
			}),
			{
				env: { PLUXEL_HOST_BIND: '127.0.0.1', PLUXEL_HOST_PORT: '0' },
				deployment: { root: fixture.path, target: 'node', variant: 'workbench' },
			},
		)
		let stopped = false
		try {
			const connection = connectRuntimeSession('127.0.0.1', runtime.address.port, 'http:')
			await withTimeout(waitForOpen(connection.socket))
			const invalidation = Promise.withResolvers<RuntimeSessionEvent>()
			const ready = await connection.root.bootstrap((event) =>
				invalidation.resolve(Object.freeze({ ...event })),
			)
			try {
				expect(ready).toMatchObject({ kind: 'workbench', profile: 1 })
				if (ready.kind !== 'workbench') throw new Error('local ready capabilities missing')
				const management = await ready.management.describe()
				const layout = await ready.workbench.layout({ target: null })
				try {
					expect(management).toMatchObject({
						protocol: { name: 'pluxel.management', major: 1 },
						workbench: { enabled: true },
					})
					expect(layout).toMatchObject({ profile: 1, target: null, entries: [] })
				} finally {
					disposeRpcValue(management)
					disposeRpcValue(layout)
				}
			} finally {
				disposeRpcValue(ready)
			}

			const closed = waitForClose(connection.socket)
			const stop = runtime.stop()
			await expect(withTimeout(invalidation.promise)).resolves.toEqual({
				kind: 'epoch-invalidated',
				cause: 'service-restart',
			})
			await expect(withTimeout(closed)).resolves.toMatchObject({ code: 1012 })
			await stop
			stopped = true
			connection.root[Symbol.dispose]()
		} finally {
			if (!stopped) await runtime.stop()
		}
	}, 20_000)
})

function connectRuntimeSession(
	host: string,
	port: number,
	originProtocol: 'http:' | 'https:',
): Readonly<{ socket: WebSocket; root: RpcStub<RuntimeSessionRoot> }> {
	const WebSocketConstructor = NodeWebSocket as unknown as new (
		url: string,
		protocols: string[],
		options: { headers: Record<string, string> },
	) => WebSocket
	const socket = new WebSocketConstructor(`ws://${host}:${port}${RUNTIME_SESSION_PATH}`, [], {
		headers: { origin: `${originProtocol}//${host}:${port}` },
	})
	return Object.freeze({
		socket,
		root: newWebSocketRpcSession<RuntimeSessionRoot>(socket),
	})
}

async function authenticate(
	root: RpcStub<RuntimeSessionRoot>,
	observer: RuntimeSessionObserver,
): Promise<void> {
	const challenge = await root.bootstrap(observer)
	try {
		if (challenge.kind !== 'authentication-required') throw new Error('challenge missing')
		const step = await challenge.authentication.submit({ password: 'correct' })
		disposeRpcValue(step)
	} finally {
		disposeRpcValue(challenge)
	}
	const ready = await root.bootstrap(observer)
	try {
		if (ready.kind !== 'workbench') throw new Error('ready capabilities missing')
	} finally {
		disposeRpcValue(ready)
	}
}

function disposeRpcValue(value: unknown): void {
	const dispose = (value as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]
	dispose?.call(value)
}

function waitForClose(socket: WebSocket): Promise<Readonly<{ code: number; reason: string }>> {
	if (socket.readyState === WebSocket.CLOSED) {
		return Promise.resolve(Object.freeze({ code: 1006, reason: '' }))
	}
	return new Promise((resolve) => {
		socket.addEventListener(
			'close',
			(event) => resolve(Object.freeze({ code: event.code, reason: event.reason })),
			{ once: true },
		)
	})
}

function waitForOpen(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
	return new Promise((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true })
		socket.addEventListener('error', () => reject(new Error('Runtime Session socket failed')), {
			once: true,
		})
	})
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for Runtime Session state')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

async function withTimeout<T>(promise: Promise<T>, label = 'result'): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timed out waiting for Runtime Session ${label}`)),
				TEST_TIMEOUT_MS,
			)
			timer.unref?.()
		}),
	])
}
