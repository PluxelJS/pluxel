import { describe, expect, it, vi } from 'vitest'
import { AuthHttpController, type AuthHttpActions, type SetupSnapshot } from '../src/http.ts'

function actions(snapshot: SetupSnapshot): AuthHttpActions {
	return {
		snapshot: () => snapshot,
		authorize: vi.fn(async () => ({
			allow: true as const,
			principal: { subject: 'local:admin' },
		})),
		login: vi.fn(async () => ({
			ok: true as const,
			cookie: '__Host-pluxel_admin_session=session; Path=/; Secure; HttpOnly',
		})),
		setupPassword: vi.fn(async () => ({ ok: true as const })),
		beginTotp: vi.fn(async () => ({ ok: false as const, message: 'not used' })),
		confirmTotp: vi.fn(async () => ({ ok: true as const })),
		setupOidcSecret: vi.fn(async () => ({ ok: true as const })),
		startOidc: vi.fn(async () => new Response(null, { status: 302 })),
		finishOidc: vi.fn(async () => ({
			ok: false as const,
			unavailable: false,
			clearStateCookie: 'state=; Max-Age=0',
		})),
		logout: vi.fn(() => 'session=; Max-Age=0'),
	}
}

describe('server-rendered authentication pages', () => {
	it('returns only SSH setup guidance when a remote provider is not ready', async () => {
		const controller = new AuthHttpController(
			actions({
				method: 'password',
				ready: false,
				vaultAvailable: true,
				credentialsInvalid: false,
			}),
		)
		const response = await controller.handle(
			new Request('https://admin.example/__pluxel/admin-access/'),
			{ local: false, secure: true },
		)
		expect(response?.status).toBe(503)
		const body = await response!.text()
		expect(body).toContain('SSH tunnel')
		expect(body).not.toContain('Vault')
		expect(response?.headers.get('cache-control')).toBe('no-store')
	})

	it('renders a CSRF-bound password form and rejects an external return URL', async () => {
		const state = actions({
			method: 'password',
			ready: true,
			vaultAvailable: true,
			credentialsInvalid: false,
			accountName: 'admin',
		})
		const controller = new AuthHttpController(state)
		const landing = await controller.handle(
			new Request('https://admin.example/__pluxel/admin-access/login?returnTo=%2F%2Fevil.example'),
			{ local: false, secure: true },
		)
		const body = await landing!.text()
		const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(body)?.[1]
		const cookie = landing!.headers.get('set-cookie')!.split(';', 1)[0]!
		expect(csrf).toHaveLength(43)
		expect(body).toContain('name="returnTo" value="/"')
		expect(landing?.headers.get('content-security-policy')).toContain("form-action 'self'")

		const response = await controller.handle(
			new Request('https://admin.example/__pluxel/admin-access/login', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie,
					origin: 'https://admin.example',
				},
				body: new URLSearchParams({
					csrf: csrf!,
					username: 'admin',
					password: 'correct horse battery staple',
					returnTo: '/plugins',
				}),
			}),
			{ local: false, secure: true },
		)
		expect(response?.status).toBe(303)
		expect(response?.headers.get('location')).toBe('/plugins')
		expect(state.login).toHaveBeenCalledWith({
			username: 'admin',
			password: 'correct horse battery staple',
			secure: true,
		})
	})

	it('keeps setup local and explains a missing Vault without exposing a mutation', async () => {
		const controller = new AuthHttpController(
			actions({
				method: 'password-totp',
				ready: false,
				vaultAvailable: false,
				credentialsInvalid: false,
			}),
		)
		const remote = await controller.handle(
			new Request('https://admin.example/__pluxel/admin-access/setup'),
			{ local: false, secure: true },
		)
		expect(remote?.status).toBe(404)
		const local = await controller.handle(
			new Request('http://127.0.0.1/__pluxel/admin-access/setup'),
			{ local: true, secure: false },
		)
		expect(await local!.text()).toContain('enable and unlock Vault')
	})

	it('does not require Vault for a public OIDC client', async () => {
		const controller = new AuthHttpController(
			actions({
				method: 'oidc',
				ready: true,
				vaultAvailable: false,
				credentialsInvalid: false,
				clientSecretRequired: false,
				clientSecretConfigured: false,
			}),
		)
		const response = await controller.handle(
			new Request('http://127.0.0.1/__pluxel/admin-access/setup'),
			{ local: true, secure: false },
		)
		const body = await response!.text()
		expect(body).toContain('does not require a stored client secret')
		expect(body).not.toContain('enable and unlock Vault')
	})

	it('cancels an oversized streamed form before invoking login', async () => {
		const state = actions({
			method: 'password',
			ready: true,
			vaultAvailable: true,
			credentialsInvalid: false,
		})
		const controller = new AuthHttpController(state)
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new Uint8Array(16 * 1_024 + 1))
				stream.close()
			},
		})
		const response = await controller.handle(
			new Request('https://admin.example/__pluxel/admin-access/login', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					origin: 'https://admin.example',
				},
				body,
				duplex: 'half',
			} as RequestInit),
			{ local: false, secure: true },
		)
		expect(response?.status).toBe(400)
		expect(state.login).not.toHaveBeenCalled()
	})
})
