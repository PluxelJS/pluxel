import type { Context } from '@pluxel/core'
import type { ElysiaWS } from 'elysia/ws'
import { describe, expect, it, vi } from 'vitest'

import type {
	AdminAccessService,
	AdminAuthenticationSession,
} from '../../src/services/admin-access/AdminAccessService.ts'
import { RuntimeSessionWebSocket } from '../../src/web/session/elysia-websocket.ts'
import {
	matchesRuntimeSessionUpgrade,
	RuntimeSessionIngress,
	validateRuntimeSessionOrigin,
} from '../../src/web/session/ingress.ts'

const RUNTIME_SESSION_URL = 'https://runtime.test/__pluxel/runtime/session'

function createUpgradeRequest(
	options: Readonly<{
		url?: string
		method?: string
		host?: string | null
		origin?: string | null
		connection?: string | null
		upgrade?: string | null
		fetchSite?: string | null
		protocol?: string | null
		forwardedHost?: string | null
	}> = {},
): Request {
	const headers = new Headers()
	for (const [name, value] of [
		['host', options.host === undefined ? 'runtime.test' : options.host],
		['origin', options.origin === undefined ? 'https://runtime.test' : options.origin],
		['connection', options.connection === undefined ? 'keep-alive, Upgrade' : options.connection],
		['upgrade', options.upgrade === undefined ? 'websocket' : options.upgrade],
		['sec-fetch-site', options.fetchSite === undefined ? 'same-origin' : options.fetchSite],
		['sec-websocket-protocol', options.protocol],
		['x-forwarded-host', options.forwardedHost],
	] as const) {
		if (value !== null && value !== undefined) headers.set(name, value)
	}
	return new Request(options.url ?? RUNTIME_SESSION_URL, {
		method: options.method ?? 'GET',
		headers,
	})
}

function createAuthentication(): AdminAuthenticationSession {
	const controller = new AbortController()
	return {
		signal: controller.signal,
		providerId: 'runtime-session-ingress-test',
		state: async () => ({
			kind: 'challenge',
			challenge: { kind: 'password', label: 'Test password' },
		}),
		submit: async () => ({ kind: 'failed', code: 'authentication_failed' }),
		logout: async () => undefined,
		release: vi.fn(),
	}
}

function createIngress(authentication: Promise<AdminAuthenticationSession>) {
	const onRelease = vi.fn()
	const ingress = new RuntimeSessionIngress({
		ctx: {} as Context,
		adminAccess: {
			openSession: vi.fn(() => authentication),
		} as unknown as AdminAccessService,
		request: new Request('https://runtime.test/__pluxel/runtime/session'),
		local: false,
		secure: true,
		workbench: false,
		onRelease,
	})
	return { ingress, onRelease }
}

function createSocket() {
	const close = vi.fn()
	const socket = {
		readyState: WebSocket.OPEN,
		raw: { close },
		close: vi.fn(),
		send: vi.fn(() => 1),
	} as unknown as ElysiaWS<any>
	return { close, socket }
}

describe('RuntimeSessionIngress initialization', () => {
	it('replays messages received before authentication setup completes', async () => {
		const pending = Promise.withResolvers<AdminAuthenticationSession>()
		const authentication = createAuthentication()
		const { ingress, onRelease } = createIngress(pending.promise)
		const { socket } = createSocket()
		const receive = vi.spyOn(RuntimeSessionWebSocket.prototype, 'receive')

		const opening = ingress.data.open(socket)
		ingress.data.message(socket, '{"question":1}')
		expect(receive).not.toHaveBeenCalled()

		pending.resolve(authentication)
		await opening
		expect(receive).toHaveBeenCalledOnce()
		expect(receive).toHaveBeenCalledWith('{"question":1}')

		ingress.release()
		expect(authentication.release).toHaveBeenCalledOnce()
		expect(onRelease).toHaveBeenCalledOnce()
		receive.mockRestore()
	})

	it.each([
		{
			name: 'message count',
			send(ingress: RuntimeSessionIngress, socket: ElysiaWS<any>) {
				for (let index = 0; index < 33; index += 1) ingress.data.message(socket, '{}')
			},
		},
		{
			name: 'total bytes',
			send(ingress: RuntimeSessionIngress, socket: ElysiaWS<any>) {
				ingress.data.message(socket, 'x'.repeat(256 * 1024 + 1))
			},
		},
	])('closes initialization that exceeds the $name ceiling', async ({ send }) => {
		const pending = Promise.withResolvers<AdminAuthenticationSession>()
		const authentication = createAuthentication()
		const { ingress, onRelease } = createIngress(pending.promise)
		const { close, socket } = createSocket()

		const opening = ingress.data.open(socket)
		send(ingress, socket)
		expect(close).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledWith(1009, 'Runtime session initialization queue exceeded')
		expect(ingress.signal.aborted).toBe(true)

		pending.resolve(authentication)
		await opening
		expect(authentication.release).toHaveBeenCalledOnce()
		ingress.release()
		expect(onRelease).toHaveBeenCalledOnce()
	})

	it('aborts asynchronous authentication as soon as the physical transport closes', async () => {
		const pending = Promise.withResolvers<AdminAuthenticationSession>()
		const authentication = createAuthentication()
		const { ingress, onRelease } = createIngress(pending.promise)
		const { socket } = createSocket()

		const opening = ingress.data.open(socket)
		ingress.data.close(socket, 1000, 'client closed')
		expect(ingress.signal.aborted).toBe(true)

		pending.resolve(authentication)
		await opening
		expect(authentication.release).toHaveBeenCalledOnce()
		ingress.release()
		expect(onRelease).toHaveBeenCalledOnce()
	})
})

describe('Runtime Session physical ingress contract', () => {
	it('matches only the exact WebSocket Upgrade request', () => {
		expect(matchesRuntimeSessionUpgrade(createUpgradeRequest())).toBe(true)
		expect(
			matchesRuntimeSessionUpgrade(
				createUpgradeRequest({ connection: 'UPGRADE', upgrade: 'WebSocket' }),
			),
		).toBe(true)
	})

	it.each([
		['non-GET method', { method: 'POST' }],
		['different path', { url: 'https://runtime.test/__pluxel/runtime/session/' }],
		['query parameters', { url: `${RUNTIME_SESSION_URL}?transport=websocket` }],
		['missing Upgrade header', { upgrade: null }],
		['different Upgrade protocol', { upgrade: 'h2c' }],
		['missing Connection header', { connection: null }],
		['Connection without Upgrade token', { connection: 'keep-alive' }],
	] as const)('rejects %s', (_name, options) => {
		expect(matchesRuntimeSessionUpgrade(createUpgradeRequest(options))).toBe(false)
	})

	it.each([
		['secure same-origin', createUpgradeRequest(), true],
		[
			'insecure same-origin on an insecure carrier',
			createUpgradeRequest({
				url: 'http://runtime.test/__pluxel/runtime/session',
				origin: 'http://runtime.test',
			}),
			false,
		],
		[
			'URL host fallback when the Host header is absent',
			createUpgradeRequest({ host: null }),
			true,
		],
	] as const)('accepts %s', (_name, request, secure) => {
		expect(validateRuntimeSessionOrigin(request, secure)).toBe(true)
	})

	it.each([
		['missing Origin', createUpgradeRequest({ origin: null }), true],
		['cross-site fetch metadata', createUpgradeRequest({ fetchSite: 'cross-site' }), true],
		['any WebSocket subprotocol', createUpgradeRequest({ protocol: 'capnweb' }), true],
		['empty WebSocket subprotocol header', createUpgradeRequest({ protocol: '' }), true],
		['different Origin host', createUpgradeRequest({ origin: 'https://other.test' }), true],
		[
			'forwarded host substitution',
			createUpgradeRequest({
				host: 'internal.test',
				origin: 'https://public.test',
				forwardedHost: 'public.test',
			}),
			true,
		],
		['opaque Origin', createUpgradeRequest({ origin: 'null' }), true],
		['non-HTTP Origin', createUpgradeRequest({ origin: 'file://' }), true],
		['Origin credentials', createUpgradeRequest({ origin: 'https://user@runtime.test' }), true],
		['Origin path', createUpgradeRequest({ origin: 'https://runtime.test/path' }), true],
		['Origin query', createUpgradeRequest({ origin: 'https://runtime.test?query' }), true],
		[
			'insecure Origin on a secure carrier',
			createUpgradeRequest({ origin: 'http://runtime.test' }),
			true,
		],
	] as const)('rejects %s', (_name, request, secure) => {
		expect(validateRuntimeSessionOrigin(request, secure)).toBe(false)
	})
})
