import { RUNTIME_INTERNAL_API_BASE } from '@pluxel/runtime/internal'
import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'
import { generateTotpForTesting } from '../src/totp.ts'

const ADMIN_ACCESS = '/__pluxel/admin-access'
const LOCAL_ORIGIN = 'http://runtime.test:3000'
const REMOTE_ORIGIN = 'https://runtime.test:3000'
const PASSWORD = 'correct horse battery staple'

function runtimeRequest(
	origin: string,
	path: string,
	peer: 'local' | 'remote',
	init: RequestInit = {},
): Request {
	const headers = new Headers(init.headers)
	headers.set('x-auth-test-peer', peer)
	return new Request(`${origin}${path}`, { ...init, headers })
}

function cookiePair(response: Response): string {
	const cookie = response.headers.get('set-cookie')
	if (!cookie) throw new Error('Expected a Set-Cookie header')
	return cookie.split(';', 1)[0]!
}

function csrfToken(html: string): string {
	const token = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1]
	if (!token) throw new Error('Expected a CSRF token')
	return token
}

async function formState(response: Response): Promise<Readonly<{ cookie: string; csrf: string }>> {
	const cookie = cookiePair(response)
	const csrf = csrfToken(await response.text())
	return { cookie, csrf }
}

function postForm(
	origin: string,
	path: string,
	peer: 'local' | 'remote',
	cookie: string,
	fields: Record<string, string>,
): Request {
	return runtimeRequest(origin, path, peer, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			cookie,
			origin,
		},
		body: new URLSearchParams(fields),
	})
}

function authHostConfig() {
	return {
		management: {},
		workbench: { enabled: true },
		vault: {},
	} as const
}

function peerAddress(request: Request) {
	const local = request.headers.get('x-auth-test-peer') === 'local'
	return Object.freeze({
		address: local ? '127.0.0.1' : '203.0.113.9',
		port: 45_000,
		family: 'IPv4' as const,
	})
}

async function withAuthHost(run: (host: RuntimeHost) => Promise<void>): Promise<void> {
	const host = createRuntimeHost(authHostConfig(), { requestAddress: peerAddress })
	try {
		await run(host)
	} finally {
		await host.dispose()
	}
}

async function startAuth(
	host: RuntimeHost,
	mode: { type: 'password' } | { type: 'password-totp' },
): Promise<AuthPlugin> {
	host.add(AuthPlugin)
	host.cfg(AuthPlugin).set({ mode })
	host.start(AuthPlugin)
	await host.commit()
	return host.require(AuthPlugin)
}

describe('official authentication Runtime integration', () => {
	it('sets up locally, protects every peer when ready, and revokes sessions on stop', async () => {
		await withAuthHost(async (host) => {
			const plugin = await startAuth(host, { type: 'password' })
			const setupPage = await host.fetch(
				runtimeRequest(LOCAL_ORIGIN, `${ADMIN_ACCESS}/setup`, 'local'),
			)
			expect(setupPage.status).toBe(200)
			const setup = await formState(setupPage)
			const saved = await host.fetch(
				postForm(LOCAL_ORIGIN, `${ADMIN_ACCESS}/setup`, 'local', setup.cookie, {
					csrf: setup.csrf,
					action: 'password',
					username: 'admin',
					password: PASSWORD,
					passwordConfirmation: PASSWORD,
				}),
			)
			expect(saved.status).toBe(200)
			expect(plugin.status().ready).toBe(true)

			const [localApi, localUi, setupWithoutSession] = await Promise.all([
				host.fetch(runtimeRequest(LOCAL_ORIGIN, `${RUNTIME_INTERNAL_API_BASE}/meta`, 'local')),
				host.fetch(
					runtimeRequest(LOCAL_ORIGIN, '/', 'local', {
						headers: { accept: 'text/html' },
					}),
				),
				host.fetch(runtimeRequest(LOCAL_ORIGIN, `${ADMIN_ACCESS}/setup`, 'local')),
			])
			expect(localApi.status).toBe(401)
			expect(localUi.status).toBe(302)
			expect(setupWithoutSession.status).toBe(401)

			const localLanding = await host.fetch(
				runtimeRequest(LOCAL_ORIGIN, `${ADMIN_ACCESS}/login`, 'local'),
			)
			const localLogin = await formState(localLanding)
			const locallySignedIn = await host.fetch(
				postForm(LOCAL_ORIGIN, `${ADMIN_ACCESS}/login`, 'local', localLogin.cookie, {
					csrf: localLogin.csrf,
					username: 'admin',
					password: PASSWORD,
					returnTo: '/',
				}),
			)
			const localSession = cookiePair(locallySignedIn)
			expect(localSession).toContain('pluxel_admin_local_session=')
			const localManagement = await host.fetch(
				runtimeRequest(LOCAL_ORIGIN, `${RUNTIME_INTERNAL_API_BASE}/meta`, 'local', {
					headers: { cookie: localSession },
				}),
			)
			expect(localManagement.status).toBe(200)
			const localCookieFromRemote = await host.fetch(
				runtimeRequest(REMOTE_ORIGIN, `${RUNTIME_INTERNAL_API_BASE}/meta`, 'remote', {
					headers: { cookie: localSession },
				}),
			)
			expect(localCookieFromRemote.status).toBe(401)

			const landing = await host.fetch(
				runtimeRequest(REMOTE_ORIGIN, `${ADMIN_ACCESS}/login`, 'remote'),
			)
			const login = await formState(landing)
			const signedIn = await host.fetch(
				postForm(REMOTE_ORIGIN, `${ADMIN_ACCESS}/login`, 'remote', login.cookie, {
					csrf: login.csrf,
					username: 'admin',
					password: PASSWORD,
					returnTo: '/',
				}),
			)
			expect(signedIn.status).toBe(303)
			const session = cookiePair(signedIn)
			const authenticated = runtimeRequest(
				REMOTE_ORIGIN,
				`${RUNTIME_INTERNAL_API_BASE}/meta`,
				'remote',
				{ headers: { cookie: session } },
			)
			const management = await host.fetch(authenticated)
			expect(management.status).toBe(200)
			const authenticatedState = await host.fetch(
				runtimeRequest(REMOTE_ORIGIN, `${ADMIN_ACCESS}/state`, 'remote', {
					headers: { cookie: session },
				}),
			)
			await expect(authenticatedState.json()).resolves.toEqual({ state: 'allowed' })
			await expect(plugin.authenticate(authenticated)).resolves.toMatchObject({
				allow: true,
				principal: { subject: 'local:admin' },
			})

			host.stop(AuthPlugin)
			await host.commit()
			const afterStop = await host.fetch(
				runtimeRequest(REMOTE_ORIGIN, `${RUNTIME_INTERNAL_API_BASE}/meta`, 'remote', {
					headers: { cookie: session },
				}),
			)
			expect(afterStop.status).toBe(403)
			await expect(afterStop.json()).resolves.toMatchObject({
				code: 'management_local_setup_required',
			})
		})
	})

	it('enrolls TOTP locally and rejects a replayed login code', async () => {
		await withAuthHost(async (host) => {
			await startAuth(host, { type: 'password-totp' })
			const setup = await formState(
				await host.fetch(runtimeRequest(LOCAL_ORIGIN, `${ADMIN_ACCESS}/setup`, 'local')),
			)
			const enrollment = await host.fetch(
				postForm(LOCAL_ORIGIN, `${ADMIN_ACCESS}/setup`, 'local', setup.cookie, {
					csrf: setup.csrf,
					action: 'begin-totp',
					username: 'admin',
					password: PASSWORD,
					passwordConfirmation: PASSWORD,
				}),
			)
			const enrollmentHtml = await enrollment.text()
			const enrollmentId = /name="enrollmentId" value="([A-Za-z0-9_-]+)"/.exec(enrollmentHtml)?.[1]
			const secret = /<code>([A-Z2-7]{32})<\/code>/.exec(enrollmentHtml)?.[1]
			expect(enrollmentId).toBeTruthy()
			expect(secret).toBeTruthy()
			const confirmed = await host.fetch(
				postForm(LOCAL_ORIGIN, `${ADMIN_ACCESS}/setup`, 'local', setup.cookie, {
					csrf: setup.csrf,
					action: 'confirm-totp',
					enrollmentId: enrollmentId!,
					otp: generateTotpForTesting(secret!, Date.now() - 30_000),
				}),
			)
			expect(confirmed.status).toBe(200)

			const login = await formState(
				await host.fetch(runtimeRequest(REMOTE_ORIGIN, `${ADMIN_ACCESS}/login`, 'remote')),
			)
			const otp = generateTotpForTesting(secret!)
			const fields = {
				csrf: login.csrf,
				username: 'admin',
				password: PASSWORD,
				otp,
				returnTo: '/',
			}
			const signedIn = await host.fetch(
				postForm(REMOTE_ORIGIN, `${ADMIN_ACCESS}/login`, 'remote', login.cookie, fields),
			)
			expect(signedIn.status).toBe(303)
			const session = cookiePair(signedIn)
			const management = await host.fetch(
				runtimeRequest(REMOTE_ORIGIN, `${RUNTIME_INTERNAL_API_BASE}/meta`, 'remote', {
					headers: { cookie: session },
				}),
			)
			expect(management.status).toBe(200)

			const replay = await host.fetch(
				postForm(REMOTE_ORIGIN, `${ADMIN_ACCESS}/login`, 'remote', login.cookie, fields),
			)
			expect(replay.status).toBe(401)
		})
	})
})
