import type { Context } from '@pluxel/core'
import type { ElysiaWS } from 'elysia/ws'
import { describe, expect, it, vi } from 'vitest'

import type {
	AdminAccessService,
	AdminAuthenticationSession,
} from '../../src/services/admin-access/AdminAccessService.ts'
import { RuntimeSessionWebSocket } from '../../src/web/session/elysia-websocket.ts'
import { RuntimeSessionIngress } from '../../src/web/session/ingress.ts'

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
