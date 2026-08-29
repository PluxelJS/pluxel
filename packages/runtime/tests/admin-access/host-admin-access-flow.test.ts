import type {
	ManagementAccessProviderDecision,
	ManagementAccessRequestContext,
} from '@pluxel/runtime'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import { RUNTIME_ADMIN_ACCESS_BASE, RUNTIME_INTERNAL_API_BASE } from '../../src/web/paths'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let providerReady = true
let providerDecision: ManagementAccessProviderDecision = {
	allow: false,
	reason: 'unauthenticated',
}
let authorizeCalls = 0
let handleCalls = 0
let providerStatusError: Error | undefined
let authorizeOverride:
	| ((
			request: Request,
			context: ManagementAccessRequestContext,
	  ) => Promise<ManagementAccessProviderDecision>)
	| undefined
let handleOverride: ((request: Request) => Promise<Response | undefined>) | undefined

@Plugin()
class FixtureManagementAuthPlugin extends BasePlugin {
	override init(): void {
		this.ctx.managementAccess?.provide({
			status: () => {
				if (providerStatusError) throw providerStatusError
				return {
					id: '@fixture/auth',
					label: 'Fixture authentication',
					method: 'password',
					ready: providerReady,
				}
			},
			authorize: async (providerRequest, context) => {
				authorizeCalls += 1
				if (authorizeOverride) return authorizeOverride(providerRequest, context)
				return providerDecision
			},
			handle: async (providerRequest) => {
				handleCalls += 1
				if (handleOverride) return handleOverride(providerRequest)
				if (new URL(providerRequest.url).pathname !== '/') return undefined
				return new Response('<!doctype html><title>Fixture login</title>', {
					headers: { 'content-type': 'text/html; charset=utf-8' },
				})
			},
		})
		this.ctx.elysia.get('/business-health', 'ok')
	}
}

const remotePeer = () =>
	Object.freeze({ address: '203.0.113.9', port: 45000, family: 'IPv4' as const })
const peer = (address: string) => () =>
	Object.freeze({
		address,
		port: 45000,
		family: address.includes(':') ? ('IPv6' as const) : ('IPv4' as const),
	})

function request(path: string, init: RequestInit = {}): Request {
	return new Request(`https://runtime.test:3000${path}`, init)
}

function insecureRequest(path: string, init: RequestInit = {}): Request {
	return new Request(`http://runtime.test:3000${path}`, init)
}

function createRemoteHost(): RuntimeHost {
	return createRuntimeHost(
		{ management: {}, workbench: { enabled: true }, vault: {} },
		{ requestAddress: remotePeer },
	)
}

describe('host Management access boundary', () => {
	let host: RuntimeHost | undefined

	beforeEach(() => {
		providerReady = true
		providerDecision = { allow: false, reason: 'unauthenticated' }
		authorizeCalls = 0
		handleCalls = 0
		providerStatusError = undefined
		authorizeOverride = undefined
		handleOverride = undefined
	})

	afterEach(async () => {
		await host?.dispose()
		host = undefined
	})

	it.each(['127.0.0.1', '127.42.7.9', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
		'allows a physical loopback peer without an authentication provider: %s',
		async (address) => {
			host = createRuntimeHost(
				{ workbench: false, management: {} },
				{ requestAddress: peer(address) },
			)
			const response = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
			expect(response.status).toBe(200)
		},
	)

	it('fails closed for remote and unknown peers and exposes only the SSH guide', async () => {
		host = createRemoteHost()
		const [api, securityWrite, ui, landing, state] = await Promise.all([
			host.fetch(insecureRequest(`${RUNTIME_INTERNAL_API_BASE}/meta`)),
			host.fetch(
				insecureRequest(`${RUNTIME_INTERNAL_API_BASE}/security/vault/unlock`, { method: 'POST' }),
			),
			host.fetch(insecureRequest('/', { headers: { accept: 'text/html' } })),
			host.fetch(insecureRequest(RUNTIME_ADMIN_ACCESS_BASE)),
			host.fetch(insecureRequest(`${RUNTIME_ADMIN_ACCESS_BASE}/state`)),
		])

		for (const response of [api, securityWrite]) {
			expect(response.status).toBe(403)
			await expect(response.clone().json()).resolves.toMatchObject({
				code: 'management_local_setup_required',
				reason: 'local_setup_required',
			})
		}
		expect(ui.status).toBe(302)
		expect(ui.headers.get('location')).toBe(`${RUNTIME_ADMIN_ACCESS_BASE}?returnTo=%2F`)
		expect(landing.status).toBe(403)
		expect(await landing.text()).toContain('ssh -L 3000:127.0.0.1:3000')
		await expect(state.json()).resolves.toEqual({ state: 'local_setup_required' })
	})

	it('does not trust Host or forwarding headers for locality', async () => {
		host = createRemoteHost()
		const response = await host.fetch(
			request(`${RUNTIME_INTERNAL_API_BASE}/meta`, {
				headers: {
					host: '127.0.0.1',
					'x-forwarded-for': '127.0.0.1',
					forwarded: 'for=127.0.0.1',
				},
			}),
		)
		expect(response.status).toBe(403)
	})

	it('publishes a ready provider only after its Plugin generation is running', async () => {
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin)
		host.cfg(FixtureManagementAuthPlugin).setAutoStart(true)
		host.start(FixtureManagementAuthPlugin)

		const beforeCommit = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(beforeCommit.status).toBe(403)

		await host.commit()
		const landing = await host.fetch(request(RUNTIME_ADMIN_ACCESS_BASE))
		expect(landing.status).toBe(200)
		expect(await landing.text()).toContain('Fixture login')
		await expect(
			host.fetch(request(`${RUNTIME_ADMIN_ACCESS_BASE}/state`)).then((response) => response.json()),
		).resolves.toEqual({ state: 'login_required', method: 'password' })

		const challenged = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(challenged.status).toBe(401)
		await expect(challenged.json()).resolves.toMatchObject({
			code: 'management_authentication_required',
		})
		expect(authorizeCalls).toBe(2)
	})

	it('admits authenticated Management requests and leaves business routes outside the gate', async () => {
		providerDecision = {
			allow: true,
			principal: { subject: 'account-1', displayName: 'Admin' },
		}
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()

		const [management, business] = await Promise.all([
			host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`)),
			host.fetch(request('/business-health')),
		])
		expect(management.status).toBe(200)
		expect(business.status).toBe(200)
		expect(await business.text()).toBe('ok')
		expect(authorizeCalls).toBe(1)
	})

	it('requires a ready provider for loopback too, while retaining local recovery when unready', async () => {
		host = createRuntimeHost(
			{ management: {}, workbench: { enabled: true }, vault: {} },
			{ requestAddress: peer('127.0.0.1') },
		)
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()

		const challenged = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(challenged.status).toBe(401)
		expect(authorizeCalls).toBe(1)
		await expect(
			host.fetch(request(`${RUNTIME_ADMIN_ACCESS_BASE}/state`)).then((response) => response.json()),
		).resolves.toEqual({ state: 'login_required', method: 'password' })

		providerDecision = { allow: true, principal: { subject: 'local-admin' } }
		const authenticated = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(authenticated.status).toBe(200)

		providerReady = false
		const recovering = await host.fetch(insecureRequest(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(recovering.status).toBe(200)
		await expect(
			host
				.fetch(insecureRequest(`${RUNTIME_ADMIN_ACCESS_BASE}/state`))
				.then((response) => response.json()),
		).resolves.toEqual({ state: 'allowed' })
	})

	it('rejects an insecure remote Management request before invoking a ready provider', async () => {
		providerDecision = { allow: true, principal: { subject: 'admin' } }
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()

		const response = await host.fetch(insecureRequest(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(response.status).toBe(403)
		await expect(response.json()).resolves.toMatchObject({
			code: 'management_forbidden',
			reason: 'secure_transport_required',
		})
		expect(authorizeCalls).toBe(0)
	})

	it('rejects an insecure remote authentication entry before invoking a ready provider', async () => {
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()

		const [landing, state] = await Promise.all([
			host.fetch(insecureRequest(RUNTIME_ADMIN_ACCESS_BASE)),
			host.fetch(insecureRequest(`${RUNTIME_ADMIN_ACCESS_BASE}/state`)),
		])
		expect(landing.status).toBe(403)
		expect(await landing.text()).toContain('Secure connection required')
		await expect(state.json()).resolves.toEqual({ state: 'secure_transport_required' })
		expect(authorizeCalls).toBe(0)
		expect(handleCalls).toBe(0)
	})

	it('does not expose a Management operation body to the authentication provider', async () => {
		authorizeOverride = async (providerRequest) => {
			expect(providerRequest.method).toBe('POST')
			expect(providerRequest.body).toBeNull()
			return { allow: true, principal: { subject: 'admin' } }
		}
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()

		const response = await host.fetch(
			request(`${RUNTIME_INTERNAL_API_BASE}/security/vault/unlock`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ secret: 'operation-only' }),
			}),
		)
		expect(response.status).toBe(200)
		expect(authorizeCalls).toBe(1)
	})

	it('combines client cancellation into the provider authorization signal', async () => {
		const entered = Promise.withResolvers<AbortSignal>()
		authorizeOverride = async (providerRequest, context) => {
			expect(context).toEqual({ local: false, secure: true })
			entered.resolve(providerRequest.signal)
			await new Promise<void>((_resolve, reject) => {
				providerRequest.signal.addEventListener(
					'abort',
					() => reject(providerRequest.signal.reason),
					{ once: true },
				)
			})
			return { allow: false, reason: 'unavailable' }
		}
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()
		const controller = new AbortController()
		const pending = host.fetch(
			request(`${RUNTIME_INTERNAL_API_BASE}/meta`, { signal: controller.signal }),
		)
		const providerSignal = await entered.promise
		controller.abort(new DOMException('test disconnect', 'AbortError'))
		expect(providerSignal.aborted).toBe(true)
		const cancelled = await pending
		expect(cancelled.status).toBe(503)
	})

	it('does not publish a stale entry response after provider withdrawal', async () => {
		const entered = Promise.withResolvers<void>()
		const withdrawn = Promise.withResolvers<void>()
		const response = Promise.withResolvers<Response | undefined>()
		handleOverride = async (providerRequest) => {
			entered.resolve()
			if (providerRequest.signal.aborted) withdrawn.resolve()
			else
				providerRequest.signal.addEventListener('abort', () => withdrawn.resolve(), { once: true })
			return response.promise
		}
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()
		const pendingEntry = host.fetch(request(`${RUNTIME_ADMIN_ACCESS_BASE}/login`))
		await entered.promise
		host.remove(FixtureManagementAuthPlugin)
		const stopping = host.commit()
		await withdrawn.promise
		response.resolve(
			new Response(null, {
				status: 303,
				headers: { location: '/', 'set-cookie': 'stale-session=secret' },
			}),
		)
		const stale = await pendingEntry
		expect(stale.status).toBe(503)
		expect(stale.headers.get('set-cookie')).toBeNull()
		expect(stale.headers.get('location')).toBeNull()
		await stopping
	})

	it('releases the provider generation when an entry response body cannot be leased', async () => {
		handleOverride = async () => {
			const response = new Response('locked provider body')
			response.body?.getReader()
			return response
		}
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()

		const entry = await host.fetch(request(`${RUNTIME_ADMIN_ACCESS_BASE}/login`))
		expect(entry.status).toBe(503)

		host.remove(FixtureManagementAuthPlugin)
		await expect(host.commit()).resolves.toBeDefined()
	})

	it('reports a broken provider as unavailable instead of suggesting local setup', async () => {
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()
		providerStatusError = new Error('status failed')

		const [entry, state, api] = await Promise.all([
			host.fetch(request(RUNTIME_ADMIN_ACCESS_BASE)),
			host.fetch(request(`${RUNTIME_ADMIN_ACCESS_BASE}/state`)),
			host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`)),
		])
		expect(entry.status).toBe(503)
		expect(await entry.text()).toContain('Authentication unavailable')
		await expect(state.json()).resolves.toEqual({ state: 'authentication_unavailable' })
		expect(api.status).toBe(503)
	})

	it('treats a running but unready provider as local setup required and revokes on stop', async () => {
		providerReady = false
		host = createRemoteHost()
		host.add(FixtureManagementAuthPlugin).start(FixtureManagementAuthPlugin)
		await host.commit()
		const unavailable = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(unavailable.status).toBe(403)
		expect(authorizeCalls).toBe(0)

		providerReady = true
		providerDecision = { allow: true, principal: { subject: 'admin' } }
		const available = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(available.status).toBe(200)

		host.remove(FixtureManagementAuthPlugin)
		await host.commit()
		const stopped = await host.fetch(request(`${RUNTIME_INTERNAL_API_BASE}/meta`))
		expect(stopped.status).toBe(403)
	})
})
