import '@pluxel/runtime/test'
import '@pluxel/runtime'
import '@pluxel/runtime/services/web-management'

import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_TRANSPORT_PATHS,
	RUNTIME_VERIFICATION_BASE,
} from '@pluxel/runtime/web/paths'

function req(url: string, init?: RequestInit) {
	return new Request(url, init)
}

function internalUrl(path = ''): string {
	return `http://local${RUNTIME_INTERNAL_API_BASE}${path}`
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
		management: {
			...config.management,
			enabled: true,
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

		const res = await host.ctx.http.fetch(
			req(internalUrl(), { headers: { accept: 'application/json' } }),
		)
		expect(res.status).toBe(200)
	})

	it('fails fast when public management has no OIDC config', async () => {
		host = createRuntimeHost({
			management: {
				enabled: true,
				access: { exposure: 'public' },
			},
		})

		expect(() => host!.ctx.http).toThrow(
			'Public management access requires management.access.oidc.',
		)
	})

	it('treats disabled management as private even when access is prepared for public OIDC', async () => {
		const oidc = await installOidcIssuer('future')
		host = createRuntimeHost({
			management: {
				enabled: false,
				access: {
					exposure: 'public',
					oidc: {
						issuer: oidc.issuer,
						audience: oidc.audience,
					},
				},
			},
		})

		expect(await host.ctx.verification.describe()).toMatchObject({
			exposure: 'private',
			provider: 'none',
			allow: true,
		})
	})

	it('does not require OIDC while public access is only staged for disabled management', async () => {
		host = createRuntimeHost({
			management: {
				enabled: false,
				access: { exposure: 'public' },
			},
		})

		expect(await host.ctx.verification.describe()).toMatchObject({
			exposure: 'private',
			provider: 'none',
			allow: true,
		})
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
			management: {
				enabled: true,
				access: {
					exposure: 'public',
					oidc: {
						issuer: oidc.issuer,
						audience: oidc.audience,
					},
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

	it('allows public management admin requests with a valid OIDC bearer token', async () => {
		const oidc = await installOidcIssuer('valid')
		host = createManagementHost({
			management: {
				access: {
					exposure: 'public',
					oidc: {
						issuer: oidc.issuer,
						audience: oidc.audience,
						requiredClaims: { groups: 'admins' },
					},
				},
			},
		})
		const bearer = await oidc.token({ groups: ['admins'] })

		const blocked = await host.ctx.http.fetch(
			req(internalUrl(), { headers: { accept: 'application/json' } }),
		)
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
		expect(authorization).toMatchObject({
			allow: true,
			principal: {
				provider: 'oidc',
				subject: 'user-1',
			},
		})
	})

	it('rejects valid OIDC tokens that miss required claims', async () => {
		const oidc = await installOidcIssuer('claims')
		host = createManagementHost({
			management: {
				access: {
					exposure: 'public',
					oidc: {
						issuer: oidc.issuer,
						audience: oidc.audience,
						requiredClaims: { groups: 'admins' },
					},
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
		expect(((await res.json()) as any).reason).toBe('forbidden')
	})

	it('renders a static OIDC admin access page instead of a local login form', async () => {
		const oidc = await installOidcIssuer('page')
		host = createManagementHost({
			management: {
				access: {
					exposure: 'public',
					oidc: {
						issuer: oidc.issuer,
						audience: oidc.audience,
					},
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
		expect(html).toContain('OIDC authentication is required for Pluxel admin access.')
		expect(html).not.toContain('type="password"')
	})
})
