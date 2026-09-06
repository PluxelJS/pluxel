import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { newWebSocketRpcSession, type RpcStub } from '@pluxel/runtime/capnweb'
import { requireRuntimeHttpService, type ElysiaApplicationCarrier } from '@pluxel/runtime/internal'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { NodeElysiaApplicationCarrier } from '@pluxel/runtime-node'
import { RUNTIME_SESSION_PATH, type RuntimeSessionRoot } from '@pluxel/runtime/web/session'
import NodeWebSocket from 'crossws/websocket'
import { describe, expect, it } from 'vitest'
import { CredentialStore } from '../src/credentials.ts'
import { AuthPlugin } from '../src/index.ts'
import { hashPassword } from '../src/password.ts'

const ORIGIN = 'https://runtime.test:3000'
const COOKIE_COMMIT_PATH = '/__pluxel/admin-access/cookie/commit'
const PASSWORD = 'correct horse battery staple'

function remoteRequest(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers)
	headers.set('x-auth-test-peer', 'remote')
	return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

function peerAddress() {
	return Object.freeze({ address: '203.0.113.9', port: 45_000, family: 'IPv4' as const })
}

describe('official authentication vNext Runtime integration', () => {
	it('authenticates through a physical Runtime Session WebSocket carrier', async () => {
		const fixture = new AuthRuntimeSessionCarrierFixture()
		try {
			await fixture.start()
			const connection = fixture.connect()
			await withRuntimeSessionTimeout(waitForOpen(connection.socket), 'Auth socket open')

			const challenge = await withRuntimeSessionTimeout(
				bootstrapRuntimeSession(connection.root),
				'Auth password challenge',
			)
			try {
				expect(challenge).toMatchObject({ kind: 'authentication-required', profile: 1 })
				if (challenge.kind !== 'authentication-required') {
					throw new Error('Expected Runtime Session authentication challenge')
				}
				const step = await challenge.authentication.submit({ password: PASSWORD })
				try {
					expect(step).toMatchObject({
						kind: 'authenticated',
						principal: { subject: 'local:admin', displayName: 'Admin' },
					})
				} finally {
					disposeRpcValue(step)
				}
			} finally {
				disposeRpcValue(challenge)
			}

			const ready = await withRuntimeSessionTimeout(
				bootstrapRuntimeSession(connection.root),
				'Auth management bootstrap',
			)
			try {
				expect(ready).toMatchObject({ kind: 'management', profile: 1 })
				if (ready.kind !== 'management') {
					throw new Error('Expected Runtime Session Management capability')
				}
				const management = await ready.management.describe()
				try {
					expect(management).toMatchObject({
						protocol: { name: 'pluxel.management', major: 4 },
						workbench: { enabled: false },
					})
				} finally {
					disposeRpcValue(management)
				}
			} finally {
				disposeRpcValue(ready)
				connection.root[Symbol.dispose]()
				connection.socket.close()
			}
			expect(fixture.upgradeCount).toBe(1)
		} finally {
			await fixture.dispose()
		}
	}, 15_000)

	it('runs password challenge and commits its session through the narrow endpoint', async () => {
		await using host = createRuntimeInternalTestHost(
			{ management: true, vault: {} },
			{ requestAddress: peerAddress },
		)
		await host.start(AuthPlugin, {
			initialConfig: { mode: { type: 'password' } },
		})

		const initial = host.require(AuthPlugin)
		expect(await host.ctx.adminAccess?.describe()).toMatchObject({
			provider: { method: 'password', ready: false },
		})
		const store = new CredentialStore(initial.ctx.vault)
		await store.saveAccount({
			version: 1,
			type: 'local-account',
			username: 'Admin',
			normalizedUsername: 'admin',
			password: await hashPassword(PASSWORD),
		})

		await host.stop(AuthPlugin)
		await host.start(AuthPlugin)
		expect(await host.ctx.adminAccess?.describe()).toMatchObject({
			provider: { method: 'password', ready: true },
		})

		const adminAccess = host.ctx.adminAccess
		if (!adminAccess) throw new Error('Expected Management access service')
		const authentication = await adminAccess.openSession(remoteRequest('/'), false, true)
		await expect(authentication.state()).resolves.toEqual({
			kind: 'challenge',
			challenge: { kind: 'password', label: 'Admin' },
		})
		const step = await authentication.submit({ password: PASSWORD })
		expect(step).toMatchObject({
			kind: 'authenticated',
			principal: { subject: 'local:admin', displayName: 'Admin' },
			cookieCommit: { ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
		})
		if (step.kind !== 'authenticated' || !step.cookieCommit) {
			throw new Error('Expected a cookie commit ticket')
		}

		const committed = await host.http.fetch(
			remoteRequest(COOKIE_COMMIT_PATH, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({ ticket: step.cookieCommit.ticket }),
			}),
		)
		expect(committed.status).toBe(204)
		const cookie = committed.headers.get('set-cookie')?.split(';', 1)[0]
		expect(cookie).toContain('__Host-pluxel_admin_session=')

		const restored = await adminAccess.openSession(
			remoteRequest('/', { headers: { cookie: cookie! } }),
			false,
			true,
		)
		await expect(restored.state()).resolves.toMatchObject({
			kind: 'authenticated',
			principal: { subject: 'local:admin' },
		})
		restored.release()
		authentication.release()
	})

	it('returns only the fixed OIDC navigation instruction', async () => {
		await using host = createRuntimeInternalTestHost(
			{ management: true },
			{ requestAddress: peerAddress },
		)
		await host.start(AuthPlugin, {
			initialConfig: {
				mode: {
					type: 'oidc',
					issuer: 'https://issuer.example',
					clientId: 'pluxel-client',
					publicOrigin: ORIGIN,
					clientKind: 'public',
				},
			},
		})

		const adminAccess = host.ctx.adminAccess
		if (!adminAccess) throw new Error('Expected Management access service')
		const authentication = await adminAccess.openSession(remoteRequest('/'), false, true)
		await expect(authentication.state()).resolves.toEqual({
			kind: 'navigate',
			path: '/__pluxel/admin-access/oidc/start',
		})
		authentication.release()
	})
})

class AuthRuntimeSessionCarrierFixture implements AsyncDisposable {
	readonly host = createRuntimeInternalTestHost({ management: true, vault: {} })
	readonly server: Server
	readonly carrier: NodeElysiaApplicationCarrier
	readonly trustedCarrier: ElysiaApplicationCarrier
	upgradeCount = 0

	private detachCarrier: (() => void) | undefined
	private listening = false

	constructor() {
		const http = requireRuntimeHttpService(this.host.ctx)
		this.server = createServer((_request, response) => response.writeHead(404).end('Not Found'))
		this.carrier = new NodeElysiaApplicationCarrier({
			fetch: (request) => this.host.http.fetch(request),
			matches: (request) => http.matchesWebSocketRoute(request),
			metadata: () => {
				const address = this.server.address() as AddressInfo
				return Object.freeze({
					url: new URL(`https://127.0.0.1:${address.port}/`),
					port: address.port,
					hostname: '127.0.0.1',
					development: false,
				})
			},
		})
		const carrier = this.carrier
		this.trustedCarrier = {
			get metadata() {
				return carrier.metadata
			},
			upgrade: (input) => carrier.upgrade(input),
			publish: (ownerKey, topic, data, compress) =>
				carrier.publish(ownerKey, topic, data, compress),
			pending: (ownerKey) => carrier.pending(ownerKey),
			requestIP: () => peerAddress(),
		}
		this.detachCarrier = http.attachApplicationCarrier(this.trustedCarrier)
		this.server.on('upgrade', (request, socket, head) => {
			if (!this.carrier.matchesUpgrade(request)) {
				socket.destroy()
				return
			}
			this.upgradeCount += 1
			this.carrier.handleUpgrade(request, socket, head)
		})
	}

	async start(): Promise<void> {
		const initial = await this.host.start(AuthPlugin, {
			initialConfig: { mode: { type: 'password' } },
		})
		const store = new CredentialStore(initial.ctx.vault)
		await store.saveAccount({
			version: 1,
			type: 'local-account',
			username: 'Admin',
			normalizedUsername: 'admin',
			password: await hashPassword(PASSWORD),
		})
		await this.host.stop(AuthPlugin)
		await this.host.start(AuthPlugin)
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

	async dispose(): Promise<void> {
		this.detachCarrier?.()
		this.detachCarrier = undefined
		await this.carrier.close().catch((): undefined => undefined)
		if (this.listening) {
			this.server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				this.server.close((error) => (error ? reject(error) : resolve()))
			})
			this.listening = false
		}
		await this.host.dispose()
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}
}

function disposeRpcValue(value: unknown): void {
	const dispose = (value as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]
	dispose?.call(value)
}

type RuntimeSessionBootstrap = Awaited<ReturnType<RpcStub<RuntimeSessionRoot>['bootstrap']>>

function bootstrapRuntimeSession(
	root: RpcStub<RuntimeSessionRoot>,
): Promise<RuntimeSessionBootstrap> {
	// Cap'n Web distributes a union result into a union of Promise types; the wire operation itself
	// still has one settled bootstrap value, so normalize it before applying the test timeout.
	return root.bootstrap(() => undefined) as Promise<RuntimeSessionBootstrap>
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

async function withRuntimeSessionTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timed out waiting for Runtime Session ${label}`)),
				5_000,
			)
			timer.unref?.()
		}),
	])
}
