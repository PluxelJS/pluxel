// Read this when:
// - 你要把 Authelia 作为 Pluxel host verification 的 OIDC issuer
// - 你要在插件/业务后端里单独实现一个 OIDC 登录
// - 你要确认 business login 不应该复用 ctx.root.verification 作为业务会话系统

import { createHash, randomBytes } from 'node:crypto'
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const ROUTE_BASE = '/authelia-oidc-demo'
const SESSION_COOKIE = 'pluxel_business_demo_session'
const LOGIN_STATE_COLLECTION = 'business-login-states'
const SESSION_COLLECTION = 'business-sessions'
const VAULT_NAMESPACE = 'PluginAutheliaOidcDemo'

type OidcDiscovery = {
	issuer: string
	authorization_endpoint: string
	token_endpoint: string
	jwks_uri: string
}

type LoginState = Record<string, unknown> & {
	codeVerifier: string
	nonce: string
	createdAt: number
}

type BusinessSession = Record<string, unknown> & {
	claims?: Record<string, unknown>
	createdAt: number
}

function env(name: string, fallback: string): string {
	const value = process.env[name]?.trim()
	return value || fallback
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url')
}

function sha256Base64Url(value: string): string {
	return createHash('sha256').update(value).digest('base64url')
}

function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get('cookie')
	if (!header) return undefined
	for (const part of header.split(';')) {
		const [rawName, ...rawValue] = part.trim().split('=')
		if (rawName === name) return decodeURIComponent(rawValue.join('='))
	}
	return undefined
}

@Plugin({ name: 'PluginAutheliaOidcDemo' })
export class PluginAutheliaOidcDemo extends BasePlugin {
	private readonly issuer = env('PLUXEL_AUTHELIA_ISSUER', 'http://127.0.0.1:9091')
	private readonly hostAudience = env('PLUXEL_AUTHELIA_HOST_AUDIENCE', 'pluxel-host-verification')
	private readonly businessClientId = env(
		'PLUXEL_AUTHELIA_BUSINESS_CLIENT_ID',
		'pluxel-business-demo',
	)
	private readonly businessClientSecret = env('PLUXEL_AUTHELIA_BUSINESS_CLIENT_SECRET', 'password')
	private readonly publicRouteBase = env(
		'PLUXEL_AUTHELIA_BUSINESS_PUBLIC_ROUTE_BASE',
		'http://127.0.0.1:3310/__pluxel/plugins/PluginAutheliaOidcDemo/authelia-oidc-demo',
	)
	private discovery?: Promise<OidcDiscovery>
	private jwks?: ReturnType<typeof createRemoteJWKSet>

	override async init(): Promise<void> {
		await this.seedVaultReference()

		const cookiePath = this.ctx.http.plugin.base(`${ROUTE_BASE}/business`)
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/host-verification', async ({ request }) => ({
						kind: 'pluxel-host-verification',
						verification: await this.ctx.root.verification.describe({ request }),
						oidc: {
							issuer: this.issuer,
							audience: this.hostAudience,
						},
						note: 'This endpoint reads Pluxel host verification state. It does not create a business login session.',
					}))
					.get('/business/login', async ({ set }) => {
						const login = await this.createLoginState()
						const discovery = await this.resolveDiscovery()
						const authorizationUrl = new URL(discovery.authorization_endpoint)
						authorizationUrl.searchParams.set('client_id', this.businessClientId)
						authorizationUrl.searchParams.set('redirect_uri', this.callbackUrl())
						authorizationUrl.searchParams.set('response_type', 'code')
						authorizationUrl.searchParams.set('scope', 'openid profile email groups')
						authorizationUrl.searchParams.set('state', login.state)
						authorizationUrl.searchParams.set('nonce', login.nonce)
						authorizationUrl.searchParams.set('code_challenge', login.codeChallenge)
						authorizationUrl.searchParams.set('code_challenge_method', 'S256')

						set.status = 302
						set.headers.location = authorizationUrl.toString()
						return null
					})
					.get('/business/callback', async ({ request, set, status }) => {
						const url = new URL(request.url)
						const error = url.searchParams.get('error')
						if (error) {
							return status(400, {
								ok: false,
								error,
								errorDescription: url.searchParams.get('error_description'),
							})
						}

						const code = url.searchParams.get('code')
						const state = url.searchParams.get('state')
						if (!code || !state) return status(400, { ok: false, error: 'missing_code_or_state' })

						const loginStates = this.loginStates()
						const login = await loginStates.get(state)
						await loginStates.delete(state)
						if (!login) return status(400, { ok: false, error: 'invalid_state' })

						const tokenSet = await this.exchangeCode(code, login.codeVerifier)
						const claims = await this.verifyIdToken(tokenSet.id_token, login.nonce)
						const sessionId = base64Url(randomBytes(32))
						await this.sessions().set(sessionId, {
							claims,
							createdAt: Date.now(),
						})
						await this.ctx.vault.flush()

						set.status = 302
						set.headers['set-cookie'] =
							`${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=3600`
						set.headers.location = this.ctx.http.plugin.base(`${ROUTE_BASE}/business/me`)
						return null
					})
					.get('/business/me', async ({ request, status }) => {
						const sessionId = readCookie(request, SESSION_COOKIE)
						const session = sessionId ? await this.sessions().get(sessionId) : undefined
						if (!session) return status(401, { ok: false, error: 'missing_business_session' })

						return {
							kind: 'business-oidc-session',
							issuer: this.issuer,
							clientId: this.businessClientId,
							claims: session.claims,
							note: 'This is the plugin business session. It is separate from Pluxel host verification.',
						}
					}),
			{
				path: ROUTE_BASE,
				id: 'PluginAutheliaOidcDemo:http',
			},
		)
	}

	private async seedVaultReference(): Promise<void> {
		const space = this.ctx.vault.namespace(VAULT_NAMESPACE)
		await space.docs().collection('oidc-settings').set('local-authelia', {
			issuer: this.issuer,
			hostVerificationAudience: this.hostAudience,
			businessClientId: this.businessClientId,
			businessCallbackUrl: this.callbackUrl(),
		})
		await space.kv().set('business.client_secret', this.businessClientSecret)
		await this.ctx.vault.flush()
	}

	private async createLoginState(): Promise<{
		state: string
		nonce: string
		codeChallenge: string
	}> {
		const state = base64Url(randomBytes(24))
		const nonce = base64Url(randomBytes(24))
		const codeVerifier = base64Url(randomBytes(32))
		await this.loginStates().set(state, {
			codeVerifier,
			nonce,
			createdAt: Date.now(),
		})
		await this.ctx.vault.flush()
		return {
			state,
			nonce,
			codeChallenge: sha256Base64Url(codeVerifier),
		}
	}

	private loginStates() {
		return this.ctx.vault
			.namespace(VAULT_NAMESPACE)
			.docs()
			.collection<LoginState>(LOGIN_STATE_COLLECTION)
	}

	private sessions() {
		return this.ctx.vault
			.namespace(VAULT_NAMESPACE)
			.docs()
			.collection<BusinessSession>(SESSION_COLLECTION)
	}

	private callbackUrl(): string {
		return `${this.publicRouteBase.replace(/\/+$/, '')}/business/callback`
	}

	private async resolveDiscovery(): Promise<OidcDiscovery> {
		this.discovery ??= fetch(
			`${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
			{
				headers: { accept: 'application/json' },
			},
		).then(async (response) => {
			if (!response.ok) throw new Error(`Authelia discovery failed: ${response.status}`)
			const body = (await response.json()) as Partial<OidcDiscovery>
			if (
				body.issuer !== this.issuer ||
				typeof body.authorization_endpoint !== 'string' ||
				typeof body.token_endpoint !== 'string' ||
				typeof body.jwks_uri !== 'string'
			) {
				throw new TypeError('Authelia discovery response is missing OIDC endpoints.')
			}
			return {
				issuer: body.issuer,
				authorization_endpoint: body.authorization_endpoint,
				token_endpoint: body.token_endpoint,
				jwks_uri: body.jwks_uri,
			}
		})
		return await this.discovery
	}

	private async resolveJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
		if (this.jwks) return this.jwks
		const discovery = await this.resolveDiscovery()
		this.jwks = createRemoteJWKSet(new URL(discovery.jwks_uri))
		return this.jwks
	}

	private async verifyIdToken(token: unknown, nonce: string): Promise<Record<string, unknown>> {
		if (typeof token !== 'string')
			throw new TypeError('Authelia token response is missing id_token.')
		const discovery = await this.resolveDiscovery()
		const result = await jwtVerify(token, await this.resolveJwks(), {
			issuer: discovery.issuer,
			audience: this.businessClientId,
			clockTolerance: 5,
		})
		if (result.payload.nonce !== nonce) throw new Error('Authelia id_token nonce mismatch.')
		return result.payload
	}

	private async exchangeCode(code: string, codeVerifier: string): Promise<Record<string, unknown>> {
		const discovery = await this.resolveDiscovery()
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: this.callbackUrl(),
			code_verifier: codeVerifier,
		})
		const credentials = Buffer.from(
			`${this.businessClientId}:${this.businessClientSecret}`,
			'utf8',
		).toString('base64')
		const response = await fetch(discovery.token_endpoint, {
			method: 'POST',
			headers: {
				authorization: `Basic ${credentials}`,
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body,
		})
		const payload = (await response.json()) as Record<string, unknown>
		if (!response.ok) {
			throw new Error(
				`Authelia token exchange failed: ${response.status} ${JSON.stringify(payload)}`,
			)
		}
		return payload
	}
}
