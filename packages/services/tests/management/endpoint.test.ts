import { expect, it, vi } from 'vitest'
import { createManagementEndpoint } from '../../src/management/web/session/endpoint'
import type { AdminAuthenticationSession } from '../../src/management/services/admin-access/AdminAccessService'

const request = () =>
	new Request('https://control.test/__pluxel/runtime/session', {
		headers: {
			origin: 'https://control.test',
			upgrade: 'websocket',
			connection: 'Upgrade',
			host: 'control.test',
		},
	})

it('uses carrier facts and leaves unrelated requests unhandled', async () => {
	const authentication = { openSession: vi.fn(), handleEntryRequest: vi.fn() }
	using endpoint = createManagementEndpoint({
		authentication,
		createManagement: vi.fn(),
		onError: vi.fn(),
	})
	expect(await endpoint.fetch(new Request('https://control.test/business'))).toBeNull()
	const unknown = endpoint.prepareUpgrade(request())
	expect(unknown).toMatchObject({ accepted: false, response: { status: 403 } })
	const spoofed = endpoint.prepareUpgrade(request(), {
		address: '203.0.113.7',
		secure: true,
		origin: 'https://real.test',
	})
	expect(spoofed).toMatchObject({ accepted: false, response: { status: 403 } })
	expect(authentication.openSession).not.toHaveBeenCalled()
})

it('closes pending authentication and handoffs without owning the Host', async () => {
	const pending = Promise.withResolvers<AdminAuthenticationSession>()
	let handoffSignal: AbortSignal | undefined
	const hostClose = vi.fn()
	const createManagement = vi.fn()
	const authentication = {
		openSession: vi.fn(() => pending.promise),
		handleEntryRequest: vi.fn(async (input: Request) => {
			handoffSignal = input.signal
			return new Response(null, { status: 204 })
		}),
		close: hostClose,
	}
	const endpoint = createManagementEndpoint({ authentication, createManagement, onError: vi.fn() })
	const prepared = endpoint.prepareUpgrade(request(), {
		address: '203.0.113.7',
		secure: true,
		origin: 'https://control.test',
	})
	if (prepared.accepted === false) throw new Error('Expected accepted ingress')
	const close = vi.fn()
	const opening = prepared.connection.open({ readyState: 1, send: vi.fn(), close })
	await endpoint.fetch(
		new Request('https://control.test/__pluxel/admin-access/cookie/commit', { method: 'POST' }),
		{ secure: true },
	)
	endpoint.close()
	endpoint.close()
	expect(prepared.connection.signal.aborted).toBe(true)
	expect(handoffSignal?.aborted).toBe(true)
	expect(close).toHaveBeenCalledWith(1012, 'Service Restart')
	const release = vi.fn()
	pending.resolve({
		signal: new AbortController().signal,
		providerId: 'test',
		state: async () => ({ kind: 'authenticated', principal: { subject: 'test' } }),
		submit: vi.fn(),
		logout: async () => undefined,
		release,
	})
	await opening
	expect(release).toHaveBeenCalledOnce()
	expect(createManagement).not.toHaveBeenCalled()
	expect(hostClose).not.toHaveBeenCalled()
	expect(endpoint.prepareUpgrade(request())).toMatchObject({
		accepted: false,
		response: { status: 503 },
	})
	expect(await endpoint.fetch(request())).toMatchObject({ status: 503 })
	expect(await endpoint.fetch(new Request('https://control.test/business'))).toBeNull()
})

it('borrows the authenticated artifact handler and retains its provider lease through the body', async () => {
	const release = vi.fn()
	const artifacts = vi.fn(async () => new Response('artifact'))
	const authentication = {
		openSession: vi.fn(),
		handleEntryRequest: vi.fn(),
		admit: vi.fn(async (input: Request) => ({
			state: {
				allow: true as const,
				method: 'provider' as const,
				principal: { provider: 'test', subject: 'user' },
			},
			signal: input.signal,
			release,
		})),
	}
	using endpoint = createManagementEndpoint({
		authentication,
		artifacts,
		createManagement: vi.fn(),
		onError: vi.fn(),
	})
	const response = await endpoint.fetch(
		new Request('https://control.test/__pluxel/runtime/federation/plugin/file.js'),
		{ secure: true, origin: 'https://control.test' },
	)
	expect(artifacts).toHaveBeenCalledOnce()
	expect(release).not.toHaveBeenCalled()
	expect(await response!.text()).toBe('artifact')
	expect(release).toHaveBeenCalledOnce()
})
