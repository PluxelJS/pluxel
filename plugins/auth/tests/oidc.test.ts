import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OidcClient } from '../src/oidc.ts'

afterEach(() => vi.unstubAllGlobals())

describe('OIDC authorization start', () => {
	it('uses discovery, state, nonce, and an S256 PKCE challenge', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				issuer: 'https://issuer.example',
				authorization_endpoint: 'https://issuer.example/authorize?prompt=select_account',
				token_endpoint: 'https://issuer.example/token',
				jwks_uri: 'https://issuer.example/jwks',
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
		const client = new OidcClient(
			{
				type: 'oidc',
				issuer: 'https://issuer.example',
				clientId: 'pluxel-client',
				publicOrigin: 'https://admin.example/',
				clientKind: 'public',
				scopes: ['openid', 'profile'],
			},
			() => undefined,
		)
		const response = await client.start(
			new Request('https://admin.example/__pluxel/admin-access/oidc/start'),
			'/plugins',
		)
		const location = new URL(response.headers.get('location')!)
		expect(location.origin).toBe('https://issuer.example')
		expect(location.searchParams.get('prompt')).toBe('select_account')
		expect(location.searchParams.get('client_id')).toBe('pluxel-client')
		expect(location.searchParams.get('redirect_uri')).toBe(
			'https://admin.example/__pluxel/admin-access/oidc/callback',
		)
		expect(location.searchParams.get('code_challenge_method')).toBe('S256')
		expect(location.searchParams.get('code_challenge')).toHaveLength(43)
		expect(location.searchParams.get('state')).toHaveLength(43)
		expect(location.searchParams.get('nonce')).toHaveLength(43)
		expect(response.headers.get('set-cookie')).toContain('HttpOnly')
		expect(response.headers.get('set-cookie')).toContain('SameSite=Lax')
		expect(response.headers.get('set-cookie')).toContain('__Secure-pluxel_admin_oidc_state=')
		expect(response.headers.get('set-cookie')).toContain(
			'Path=/__pluxel/admin-access/oidc/callback',
		)
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('uses raw confidential Basic credentials and verifies multi-audience azp', async () => {
		const issuer = 'https://issuer.example'
		const clientId = 'pluxel-client'
		const secret = 'secret:%value'
		const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
		const jwk = await exportJWK(publicKey)
		Object.assign(jwk, { kid: 'auth-key', alg: 'RS256', use: 'sig' })
		let nonce = ''
		let includeAzp = true
		let authorizationHeader: string | null = null
		const fetchMock = vi.fn(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = input instanceof Request ? input.url : String(input)
				if (url.endsWith('/.well-known/openid-configuration')) {
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
						jwks_uri: `${issuer}/jwks`,
					})
				}
				if (url === `${issuer}/token`) {
					authorizationHeader = new Headers(init?.headers).get('authorization')
					const idToken = await new SignJWT({ nonce, ...(includeAzp ? { azp: clientId } : {}) })
						.setProtectedHeader({ alg: 'RS256', kid: 'auth-key' })
						.setIssuer(issuer)
						.setAudience([clientId, 'another-audience'])
						.setSubject('admin')
						.setIssuedAt()
						.setExpirationTime('5m')
						.sign(privateKey)
					return Response.json({ id_token: idToken })
				}
				if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] })
				return new Response(null, { status: 404 })
			},
		)
		vi.stubGlobal('fetch', fetchMock)

		const client = new OidcClient(
			{
				type: 'oidc',
				issuer,
				clientId,
				publicOrigin: 'https://admin.example/',
				clientKind: 'confidential',
				scopes: ['openid'],
			},
			() => secret,
		)
		const started = await client.start(
			new Request('https://admin.example/__pluxel/admin-access/oidc/start'),
			'/plugins',
		)
		const location = new URL(started.headers.get('location')!)
		const state = location.searchParams.get('state')!
		nonce = location.searchParams.get('nonce')!
		const cookie = started.headers.get('set-cookie')!.split(';', 1)[0]!
		const result = await client.callback(
			new Request(
				`https://admin.example/__pluxel/admin-access/oidc/callback?state=${state}&code=code`,
				{ headers: { cookie } },
			),
		)
		expect(result).toMatchObject({
			ok: true,
			returnTo: '/plugins',
		})
		expect(authorizationHeader).toBe(
			`Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
		)
		if (!result.ok) throw new Error('Expected a successful OIDC callback')
		expect(result.principal.subject).toMatch(/^oidc:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/)

		includeAzp = false
		const secondStart = await client.start(
			new Request('https://admin.example/__pluxel/admin-access/oidc/start'),
			'/plugins',
		)
		const secondLocation = new URL(secondStart.headers.get('location')!)
		const secondState = secondLocation.searchParams.get('state')!
		nonce = secondLocation.searchParams.get('nonce')!
		const secondCookie = secondStart.headers.get('set-cookie')!.split(';', 1)[0]!
		await expect(
			client.callback(
				new Request(
					`https://admin.example/__pluxel/admin-access/oidc/callback?state=${secondState}&code=code`,
					{ headers: { cookie: secondCookie } },
				),
			),
		).resolves.toEqual({ ok: false, reason: 'invalid_credentials' })
	})
})
