import '@pluxel/test/setup'
import '@pluxel/runtime'

import { createHost, type Host } from '@pluxel/test'
import { afterEach, describe, expect, it } from 'vitest'
import {
	HMR_INTERNAL_API_BASE,
	HMR_SECURITY_BASE,
	HMR_SECURITY_EVENTS_PATH,
	HMR_SECURITY_VERIFICATION_METHOD_PATH,
	HMR_SECURITY_VERIFICATION_MODE_PATH,
	HMR_SECURITY_VERIFICATION_OTP_USERS_PATH,
	HMR_SECURITY_VERIFICATION_PASSWORD_USERS_PATH,
	HMR_SECURITY_VAULT_DEPLOY_GENERATE_PATH,
	HMR_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH,
	HMR_SECURITY_VAULT_HOST_KEY_PATH,
	HMR_TRANSPORT_PATHS,
	HMR_VERIFICATION_BASE,
} from '@pluxel/runtime/web/paths'
import { UI_PUBLIC_BASE } from '../../src/server/ui-public'
import { listSecurityEvents } from '../../src/services/security/audit'
import { generateTotpCode } from '../../src/services/verification/otp'

function req(url: string, init?: RequestInit) {
	return new Request(url, init)
}

function pickCookie(setCookie: string | null): string {
	if (!setCookie) throw new Error('missing Set-Cookie header')
	return setCookie.split(';')[0]!.trim()
}

function internalUrl(path = ''): string {
	return `http://local${HMR_INTERNAL_API_BASE}${path}`
}

function securityUrl(path = HMR_SECURITY_BASE): string {
	return internalUrl(path)
}

async function sealVaultForTesting(vault: unknown): Promise<void> {
	await (vault as { sealMountForTesting: () => Promise<void> }).sealMountForTesting()
}

async function setCredentials(host: Host, username = 'admin', password = 'secret') {
	await host.ctx.verification.upsertPasswordUser({ username, password })
	await host.ctx.verification.setMode('enforce')
}

function createSecurityCookie(host: Host, username = 'admin', password = 'secret'): string {
	const result = host.ctx.verification.verifyPassword({
		credentials: { username, password },
	})
	if (!result.cookie) throw new Error('missing verification cookie')
	return result.cookie.split(';')[0]!.trim()
}

async function readJson(host: Host, path: string, init?: RequestInit) {
	const res = await host.ctx.http.fetch(req(securityUrl(path), init))
	return {
		res,
		body: (await res.json()) as any,
	}
}

describe('Host verification end-to-end (http)', () => {
	let host: Host | null = null

	afterEach(async () => {
		if (!host) return
		await host.dispose()
		host = null
	})

	it('guards control-plane requests and unblocks after host verification succeeds', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		void host.ctx.http
		void host.ctx.verification
		await setCredentials(host)

		{
			const res = await host.ctx.http.fetch(req(`http://local${HMR_INTERNAL_API_BASE}${HMR_SECURITY_BASE}`))
			expect(res.status).toBe(401)
			expect(res.headers.get('X-Pluxel-Verification-Redirect')).toContain(HMR_VERIFICATION_BASE)
			const payload = (await res.json()) as any
			expect(payload?.code).toBe('verification_blocked')
			expect(payload?.reason).toBe('verification_required')
		}

		{
			const res = await host.ctx.http.fetch(
				req(internalUrl(), {
					headers: { accept: 'application/json' },
				}),
			)
			expect(res.status).toBe(401)
			expect(res.headers.get('X-Pluxel-Verification-Blocked')).toBe('1')
			expect(res.headers.get('X-Pluxel-Verification-Redirect')).toContain(HMR_VERIFICATION_BASE)
			const payload = (await res.json()) as any
			expect(payload?.code).toBe('verification_blocked')
			expect(payload?.reason).toBe('verification_required')
		}

		{
			const res = await host.ctx.http.fetch(
				req(internalUrl(HMR_TRANSPORT_PATHS.graphql), {
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
					},
					body: JSON.stringify({ query: '{ _empty }' }),
				}),
			)
			expect(res.status).toBe(401)
		}

		const cookie = await (async () => {
			const page = await host!.ctx.http.fetch(
				req(`http://local${HMR_VERIFICATION_BASE}`, { headers: { accept: 'text/html' } }),
			)
			expect(page.status).toBe(200)
			expect(await page.text()).toContain('Host Verification')

			const body = new URLSearchParams({
				returnTo: '/',
				username: 'admin',
				password: 'secret',
			})
			const res = await host!.ctx.http.fetch(
				req(`http://local${HMR_VERIFICATION_BASE}/verify/password`, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body,
				}),
			)
			expect(res.status).toBe(302)
			return pickCookie(res.headers.get('set-cookie'))
		})()

		{
			const res = await host.ctx.http.fetch(
				req(internalUrl(), {
					headers: { cookie },
				}),
			)
			expect(res.status).toBe(200)
		}
		expect(host.ctx.verification.authorize().allow).toBe(false)
		expect(host.ctx.verification.authorize({ headers: new Headers({ cookie }) }).allow).toBe(true)

		{
			const res = await host.ctx.http.fetch(
				req(`http://local${HMR_VERIFICATION_BASE}/logout`, {
					method: 'POST',
					headers: { cookie },
				}),
			)
			expect(res.status).toBe(302)
		}

		{
			const res = await host.ctx.http.fetch(req(internalUrl(), { headers: { cookie } }))
			expect(res.status).toBe(401)
		}
	})

	it('shows an explicit misconfigured message when verification credentials are missing', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		void host.ctx.http
		void host.ctx.verification
		await host.ctx.verification.setMode('enforce')

		const page = await host.ctx.http.fetch(
			req(`http://local${HMR_VERIFICATION_BASE}`, { headers: { accept: 'text/html' } }),
		)
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain('users are not configured')
		expect(html).toContain('/security')
	})

	it('redirects straight through when verification is bypassed', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		await host.ctx.verification.setMode('bypass')

		const page = await host.ctx.http.fetch(
			req(`http://local${HMR_VERIFICATION_BASE}?returnTo=%2Flogs`, {
				headers: { accept: 'text/html' },
			}),
		)
		expect(page.status).toBe(302)
		expect(page.headers.get('location')).toBe('/logs')
	})

	it('defaults to bypass when verification is not configured yet', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		expect(host.ctx.verification.describe()).toMatchObject({
			mode: 'bypass',
			allow: true,
			reason: 'bypass',
			users: [],
		})

		const res = await host.ctx.http.fetch(
			req(internalUrl(), {
				headers: { accept: 'application/json' },
			}),
		)
		expect(res.status).toBe(200)
	})

	it('allows security bootstrap while verification is misconfigured', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await host.ctx.verification.setMode('enforce')

		const snapshot = await readJson(host, HMR_SECURITY_BASE, {
			headers: { accept: 'application/json' },
		})
		expect(snapshot.res.status).toBe(200)
		expect(snapshot.body.verification.reason).toBe('misconfigured')

		const saved = await readJson(host, HMR_SECURITY_VERIFICATION_PASSWORD_USERS_PATH, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				username: 'admin',
				password: 'secret',
			}),
		})
		expect(saved.res.status).toBe(200)
		expect(saved.body.users).toEqual([{ username: 'admin' }])
		expect(host.ctx.verification.describe().users).toEqual([{ username: 'admin' }])

		const blocked = await host.ctx.http.fetch(
			req(securityUrl(HMR_SECURITY_BASE), {
				headers: { accept: 'application/json' },
			}),
		)
		expect(blocked.status).toBe(401)
		expect(blocked.headers.get('X-Pluxel-Verification-Redirect')).toContain(HMR_VERIFICATION_BASE)
	})

	it('allows security UI assets while verification is misconfigured', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await host.ctx.verification.setMode('enforce')

		const res = await host.ctx.http.fetch(
			req(`http://local${UI_PUBLIC_BASE}/app.js`, {
				headers: { accept: 'application/javascript' },
			}),
		)

		expect(res.status).not.toBe(401)
		expect(res.status).not.toBe(302)
	})

	it('does not let internal API validators block /security', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)

		host.ctx.internalApiValidation.register(() => false)

		const security = await host.ctx.http.fetch(
			req(securityUrl(HMR_SECURITY_BASE), {
				headers: { accept: 'application/json' },
			}),
		)
		expect(security.status).toBe(401)
		const securityBody = (await security.json()) as any
		expect(securityBody?.code).toBe('verification_blocked')

		const blocked = await host.ctx.http.fetch(
			req(internalUrl(), {
				headers: { accept: 'application/json' },
			}),
		)
		expect(blocked.status).toBe(403)
		const blockedBody = (await blocked.json()) as any
		expect(blockedBody?.code).toBe('internal_api_blocked')
	})

	it('redirects the /security page back to verification when credentials exist but the session is missing', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)

		const page = await host.ctx.http.fetch(
			req('http://local/security', {
				headers: { accept: 'text/html' },
			}),
		)
		expect(page.status).toBe(302)
		expect(page.headers.get('location')).toContain(`${HMR_VERIFICATION_BASE}?returnTo=%2Fsecurity`)
	})

	it('redirects blocked control-plane API requests to /security when verification is misconfigured', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await host.ctx.verification.setMode('enforce')

		const api = await host.ctx.http.fetch(
			req(internalUrl(), {
				headers: { accept: 'application/json' },
			}),
		)
		expect(api.status).toBe(401)
		expect(api.headers.get('X-Pluxel-Verification-Redirect')).toBe('/security')
	})

	it('exposes verification and vault admin through dedicated security api', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)
		const cookie = createSecurityCookie(host)

		const snapshot = await readJson(host, HMR_SECURITY_BASE, {
			headers: { cookie },
		})
		expect(snapshot.res.status).toBe(200)
		expect(snapshot.body.verification).toMatchObject({
			mode: 'enforce',
			method: 'password',
			users: [{ username: 'admin' }],
			allow: true,
		})
		expect(snapshot.body.vault).toMatchObject({
			present: false,
			unlocked: false,
		})

		const hostKey = await readJson(host, HMR_SECURITY_VAULT_HOST_KEY_PATH, {
			method: 'POST',
			headers: { cookie },
		})
		expect(hostKey.body.publicKey).toContain('age1')

		const generated = await readJson(host, HMR_SECURITY_VAULT_DEPLOY_GENERATE_PATH, {
			method: 'POST',
			headers: { cookie },
		})
		expect(generated.body).toMatchObject({
			envName: 'PLUXEL_VAULT_DEPLOY_IDENTITY',
		})

		const deploy = await readJson(host, HMR_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH, {
			method: 'POST',
			headers: {
				cookie,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				publicKeys: [generated.body.publicKey, generated.body.publicKey],
			}),
		})
		expect(deploy.body).toMatchObject({
			deploy: {
				recipients: [generated.body.publicKey],
			},
		})

		const events = await host.ctx.http.fetch(
			req(securityUrl(HMR_SECURITY_EVENTS_PATH), {
				headers: { cookie },
			}),
		)
		expect(events.status).toBe(200)
		expect(await events.json()).toEqual(expect.any(Array))
	})

	it('can disable the gate without dropping stored credentials', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)
		await host.ctx.verification.setMode('bypass')

		expect(host.ctx.verification.describe()).toMatchObject({
			mode: 'bypass',
			method: 'password',
			users: [{ username: 'admin' }],
			allow: true,
			reason: 'bypass',
		})

		const res = await host.ctx.http.fetch(req(internalUrl(), { headers: { accept: 'application/json' } }))
		expect(res.status).toBe(200)

		await host.ctx.verification.setMode('enforce')
		expect(host.ctx.verification.describe()).toMatchObject({
			mode: 'enforce',
			method: 'password',
			users: [{ username: 'admin' }],
			allow: false,
			reason: 'verification_required',
		})
	})

	it('updates gate mode through the dedicated security api', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)
		const cookie = createSecurityCookie(host)

		const saved = await readJson(host, HMR_SECURITY_VERIFICATION_MODE_PATH, {
			method: 'POST',
			headers: {
				cookie,
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				mode: 'bypass',
			}),
		})

		expect(saved.res.status).toBe(200)
		expect(saved.body).toMatchObject({
			mode: 'bypass',
			users: [{ username: 'admin' }],
			allow: true,
			reason: 'bypass',
		})
	})

	it('verification success does not implicitly unlock vault', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		await host.ctx.vaultAdmin.ensureHostKey()
		await host.ctx.vault.kv().set('token', 'secret')
		await host.ctx.vault.flush()
		await sealVaultForTesting(host.ctx.vault)
		await setCredentials(host)

		const body = new URLSearchParams({
			returnTo: '/',
			username: 'admin',
			password: 'secret',
		})
		const res = await host.ctx.http.fetch(
			req(`http://local${HMR_VERIFICATION_BASE}/verify/password`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
			}),
		)

		expect(res.status).toBe(302)
		const vault = await host.ctx.vaultAdmin.describe()
		expect(vault).toMatchObject({
			present: true,
			unlocked: false,
		})
		expect(await host.ctx.vault.kv().get('token')).toBe('secret')
	})

	it('records verification audit events in host security state', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)

		const denied = host.ctx.verification.verifyPassword({
			credentials: {
				username: 'admin',
				password: 'wrong',
			},
		})
		expect(denied.allow).toBe(false)

		const allowed = host.ctx.verification.verifyPassword({
			credentials: {
				username: 'admin',
				password: 'secret',
			},
		})
		expect(allowed.allow).toBe(true)

		host.ctx.verification.clear()

		expect(listSecurityEvents(host.ctx, 10)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					area: 'verification',
					action: 'verify',
					status: 'failure',
				}),
				expect.objectContaining({
					area: 'verification',
					action: 'verify',
					status: 'success',
				}),
				expect.objectContaining({
					area: 'verification',
					action: 'clear',
					status: 'info',
				}),
			]),
		)
	})

	it('preserves password bytes instead of trimming them', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		await host.ctx.verification.upsertPasswordUser({
			username: 'admin',
			password: ' secret ',
		})
		await host.ctx.verification.setMode('enforce')

		expect(
			host.ctx.verification.verifyPassword({
				credentials: {
					username: 'admin',
					password: 'secret',
				},
			}).allow,
		).toBe(false)

		expect(
			host.ctx.verification.verifyPassword({
				credentials: {
					username: 'admin',
					password: ' secret ',
				},
			}).allow,
		).toBe(true)
	})

	it('can switch to otp and verify with a generated code', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})

		await host.ctx.verification.setMethod('otp')
		const enrolled = await readJson(host, HMR_SECURITY_VERIFICATION_OTP_USERS_PATH, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				username: 'ops',
			}),
		})
		expect(enrolled.res.status).toBe(200)
		expect(enrolled.body.verification).toMatchObject({
			method: 'otp',
			users: [{ username: 'ops' }],
		})
		await host.ctx.verification.setMode('enforce')

		const body = new URLSearchParams({
			returnTo: '/',
			username: 'ops',
			code: enrolled.body.enrollment.secret ? '' : '',
		})
		expect(enrolled.body.enrollment.otpauthUrl).toContain('otpauth://totp/')
		expect(enrolled.body.enrollment.secret).toMatch(/^[A-Z2-7]+$/)

		const secret = enrolled.body.enrollment.secret as string
		const code = generateTotpCode(secret)
		body.set('code', code)

		const res = await host.ctx.http.fetch(
			req(`http://local${HMR_VERIFICATION_BASE}/verify/otp`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
			}),
		)
		expect(res.status).toBe(302)
	})

	it('changing verification method clears incompatible users', async () => {
		host = createHost({
			fs: { mode: 'memory' },
		})
		await setCredentials(host)
		const cookie = createSecurityCookie(host)

		const saved = await readJson(host, HMR_SECURITY_VERIFICATION_METHOD_PATH, {
			method: 'POST',
			headers: {
				cookie,
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				method: 'otp',
			}),
		})

		expect(saved.res.status).toBe(200)
		expect(saved.body).toMatchObject({
			method: 'otp',
			users: [],
			allow: false,
			reason: 'misconfigured',
		})
	})
})
