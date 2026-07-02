import '@pluxel/runtime/test'
import '@pluxel/runtime'
import '@pluxel/runtime/services/web-management'

import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_SECURITY_BASE,
	RUNTIME_TRANSPORT_PATHS,
	RUNTIME_VERIFICATION_BASE,
} from '@pluxel/runtime/web/paths'

function req(url: string, init?: RequestInit) {
	return new Request(url, init)
}

function internalUrl(path = ''): string {
	return `http://local${RUNTIME_INTERNAL_API_BASE}${path}`
}

function securityUrl(path = RUNTIME_SECURITY_BASE): string {
	return internalUrl(path)
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function createManagementHost(config: Parameters<typeof createRuntimeHost>[0] = {}): RuntimeHost {
	return createRuntimeHost({
		...config,
		http: {
			...config.http,
			management: true,
		},
	})
}

async function installOidcIssuer(name: string) {
	const issuer = `https://oidc.${name}.example`
	const audience = `pluxel-${name}`
	const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
	const jwk = await exportJWK(publicKey)
	jwk.kid = `kid-${name}`
	jwk.alg = 'RS256'
	jwk.use = 'sig'

	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url === `${issuer}/.well-known/openid-configuration`) {
				return jsonResponse({ issuer, jwks_uri: `${issuer}/jwks` })
			}
			if (url === `${issuer}/jwks`) {
				return jsonResponse({ keys: [jwk] })
			}
			return jsonResponse({ error: 'not_found' }, 404)
		}),
	)

	const token = async (claims: Record<string, unknown> = {}) =>
		await new SignJWT(claims)
			.setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
			.setIssuedAt()
			.setExpirationTime('5m')
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject(String(claims.sub ?? 'user-1'))
			.sign(privateKey)

	return { issuer, audience, token }
}

describe('Host verification gate', () => {
	let host: RuntimeHost | null = null

	afterEach(async () => {
		vi.unstubAllGlobals()
		if (!host) return
		await host.dispose()
		host = null
	})

	it('defaults to private mode and does not require credentials', async () => {
		host = createManagementHost()

		expect(await host.ctx.verification.describe()).toMatchObject({
			exposure: 'private',
			provider: 'none',
			allow: true,
			reason: 'private',
		})

		const res = await host.ctx.http.fetch(req(internalUrl(), { headers: { accept: 'application/json' } }))
		expect(res.status).toBe(200)
	})

	it('blocks public mode when OIDC is not configured', async () => {
		host = createManagementHost({
			verification: { exposure: 'public' },
		})

		const blocked = await host.ctx.http.fetch(req(internalUrl(), { headers: { accept: 'application/json' } }))
		expect(blocked.status).toBe(401)
		expect(blocked.headers.get('X-Pluxel-Verification-Redirect')).toBe('/security')
		const blockedPayload = (await blocked.json()) as any
		expect(blockedPayload.reason).toBe('missing_oidc')

		const snapshot = await host.ctx.http.fetch(req(securityUrl()))
		expect(snapshot.status).toBe(200)
		const body = (await snapshot.json()) as any
		expect(body.verification).toMatchObject({
			exposure: 'public',
			provider: 'oidc',
			allow: false,
			reason: 'missing_oidc',
		})
	})

	it('requires public OIDC config before binding a public host', async () => {
		host = createRuntimeHost({
		})

		expect(() => host!.ctx.root.verification.assertCanBindHost('127.0.0.1')).not.toThrow()
		expect(() => host!.ctx.root.verification.assertCanBindHost(undefined)).not.toThrow()
		expect(() => host!.ctx.root.verification.assertCanBindHost('0.0.0.0')).toThrow(
			'Public host binding requires verification.exposure="public" with OIDC configured.',
		)
		expect(() => host!.ctx.root.verification.assertCanBindHost('')).toThrow(
			'Public host binding requires verification.exposure="public" with OIDC configured.',
		)

		await host.dispose()
		const oidc = await installOidcIssuer('bind')
		host = createRuntimeHost({
			verification: {
				exposure: 'public',
				oidc: {
					issuer: oidc.issuer,
					audience: oidc.audience,
				},
			},
		})
		expect(() => host!.ctx.root.verification.assertCanBindHost('0.0.0.0')).not.toThrow()
	})

	it('does not permanently cache failed OIDC discovery', async () => {
		const oidc = await installOidcIssuer('retry')
		const workingFetch = globalThis.fetch
		let calls = 0
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input)
				if (url === `${oidc.issuer}/.well-known/openid-configuration` && calls++ === 0) {
					return jsonResponse({ error: 'temporary' }, 503)
				}
				return await workingFetch(input)
			}),
		)
		host = createRuntimeHost({
			verification: {
				exposure: 'public',
				oidc: {
					issuer: oidc.issuer,
					audience: oidc.audience,
				},
			},
		})
		const bearer = await oidc.token()

		const first = await host.ctx.verification.authorize({
			headers: new Headers({ authorization: `Bearer ${bearer}` }),
		})
		expect(first).toMatchObject({ allow: false, reason: 'invalid_token' })

		const second = await host.ctx.verification.authorize({
			headers: new Headers({ authorization: `Bearer ${bearer}` }),
		})
		expect(second.allow).toBe(true)
	})

	it('allows public control-plane requests with a valid OIDC bearer token', async () => {
		const oidc = await installOidcIssuer('valid')
		host = createManagementHost({
			verification: {
				exposure: 'public',
				oidc: {
					issuer: oidc.issuer,
					audience: oidc.audience,
					requiredClaims: { groups: 'admins' },
				},
			},
		})
		const bearer = await oidc.token({ groups: ['admins'] })

		const blocked = await host.ctx.http.fetch(req(internalUrl(), { headers: { accept: 'application/json' } }))
		expect(blocked.status).toBe(401)
		const blockedBody = (await blocked.json()) as any
		expect(blockedBody.reason).toBe('unauthenticated')

		const allowed = await host.ctx.http.fetch(
			req(internalUrl(), {
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${bearer}`,
				},
			}),
		)
		expect(allowed.status).toBe(200)
		const authorization = await host.ctx.verification.authorize({
			headers: new Headers({ authorization: `Bearer ${bearer}` }),
		})
		expect(authorization.allow).toBe(true)
	})

	it('rejects valid OIDC tokens that miss required claims', async () => {
		const oidc = await installOidcIssuer('claims')
		host = createManagementHost({
			verification: {
				exposure: 'public',
				oidc: {
					issuer: oidc.issuer,
					audience: oidc.audience,
					requiredClaims: { groups: 'admins' },
				},
			},
		})
		const bearer = await oidc.token({ groups: ['readers'] })

		const res = await host.ctx.http.fetch(
			req(internalUrl(RUNTIME_TRANSPORT_PATHS.graphql), {
				method: 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${bearer}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ query: '{ _empty }' }),
			}),
		)
		expect(res.status).toBe(401)
		expect((await res.json() as any).reason).toBe('forbidden')
	})

	it('renders a static external-auth page instead of a local login form', async () => {
		const oidc = await installOidcIssuer('page')
		host = createManagementHost({
			verification: {
				exposure: 'public',
				oidc: {
					issuer: oidc.issuer,
					audience: oidc.audience,
				},
			},
		})

		const page = await host.ctx.http.fetch(
			req(`http://local${RUNTIME_VERIFICATION_BASE}?returnTo=%2Flogs`, {
				headers: { accept: 'text/html' },
			}),
		)
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain('External OIDC authentication is required.')
		expect(html).not.toContain('type="password"')
	})
})
