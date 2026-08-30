import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
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

async function withAuthHost(run: (host: RuntimeHost) => Promise<void>): Promise<void> {
	const host = createRuntimeHost(
		{ workbench: { enabled: true }, vault: {} },
		{ requestAddress: peerAddress },
	)
	try {
		await run(host)
	} finally {
		await host.dispose()
	}
}

describe('official authentication vNext Runtime integration', () => {
	it('runs password challenge and commits its session through the narrow endpoint', async () => {
		await withAuthHost(async (host) => {
			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
			host.start(AuthPlugin)
			await host.commit()

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

			host.stop(AuthPlugin)
			await host.commit()
			host.start(AuthPlugin)
			await host.commit()
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

			const committed = await host.fetch(
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
	})

	it('returns only the fixed OIDC navigation instruction', async () => {
		await withAuthHost(async (host) => {
			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({
				mode: {
					type: 'oidc',
					issuer: 'https://issuer.example',
					clientId: 'pluxel-client',
					publicOrigin: ORIGIN,
					clientKind: 'public',
				},
			})
			host.start(AuthPlugin)
			await host.commit()

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
})
