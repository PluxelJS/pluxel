import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'
import type { AuthDecision, AuthPrincipal } from './contracts.ts'
import type { OidcAuthMode } from './config.ts'
import { readCookie } from './sessions.ts'

const STATE_COOKIE = '__Secure-pluxel_admin_oidc_state'
const MAX_PENDING = 128
const PENDING_TTL_MS = 10 * 60_000
const MAX_JSON_BYTES = 64 * 1_024
const NETWORK_TIMEOUT_MS = 7_500
const CALLBACK_PATH = '/__pluxel/admin-access/oidc/callback'

type Discovery = Readonly<{
	issuer: string
	authorizationEndpoint: string
	tokenEndpoint: string
	jwksUri: string
}>

type PendingAuthorization = Readonly<{
	verifier: string
	nonce: string
	returnTo: string
	expiresAt: number
}>

export type OidcCallbackResult =
	| Readonly<{ ok: true; principal: AuthPrincipal; returnTo: string }>
	| Readonly<{ ok: false; reason: 'unavailable' | 'invalid_credentials' }>

function randomToken(bytes: number = 32): string {
	return randomBytes(bytes).toString('base64url')
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('base64url')
}

function equalText(left: string, right: string): boolean {
	const a = createHash('sha256').update(left).digest()
	const b = createHash('sha256').update(right).digest()
	return timingSafeEqual(a, b)
}

function endpoint(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return undefined
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && !url.username && !url.password && !url.hash
			? url.href
			: undefined
	} catch {
		return undefined
	}
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
	const declared = Number(response.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error('Response too large')
	const text = await readBoundedText(response.body, MAX_JSON_BYTES)
	const value = JSON.parse(text) as unknown
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON')
	return value as Record<string, unknown>
}

async function readBoundedText(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<string> {
	if (!body) throw new Error('Missing response body')
	const reader = body.getReader()
	const chunks: Buffer[] = []
	let bytes = 0
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > maxBytes) {
				await reader.cancel('Response too large')
				throw new Error('Response too large')
			}
			chunks.push(Buffer.from(chunk.value))
		}
	} finally {
		reader.releaseLock()
	}
	return Buffer.concat(chunks, bytes).toString('utf8')
}

function networkSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS)
	return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function claimValues(value: unknown): readonly string[] {
	if (typeof value === 'string') return [value]
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: []
}

function claimsAllowed(payload: JWTPayload, required: OidcAuthMode['requiredClaims']): boolean {
	if (!required) return true
	for (const [name, expected] of Object.entries(required)) {
		const actual = claimValues(Object.hasOwn(payload, name) ? payload[name] : undefined)
		const expectedValues = Array.isArray(expected) ? expected : [expected]
		if (!expectedValues.some((value) => actual.includes(value))) return false
	}
	return true
}

function principal(payload: JWTPayload, issuer: string): AuthPrincipal | undefined {
	if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 1_024) {
		return undefined
	}
	const displayName = [payload.preferred_username, payload.name, payload.email].find(
		(value): value is string =>
			typeof value === 'string' && value.length > 0 && value.length <= 256,
	)
	return Object.freeze({
		subject: `oidc:${digest(issuer)}:${digest(payload.sub)}`,
		...(displayName ? { displayName } : {}),
	})
}

function authorizedPartyAllowed(payload: JWTPayload, clientId: string): boolean {
	const audiences = Array.isArray(payload.aud)
		? payload.aud
		: typeof payload.aud === 'string'
			? [payload.aud]
			: []
	if (payload.azp !== undefined && payload.azp !== clientId) return false
	return audiences.length <= 1 || payload.azp === clientId
}

function verificationFailureReason(error: unknown): 'unavailable' | 'invalid_credentials' {
	if (error instanceof errors.JWKSTimeout) return 'unavailable'
	return error instanceof errors.JOSEError ? 'invalid_credentials' : 'unavailable'
}

export class OidcClient {
	private discoveryTask?: Promise<Discovery>
	private jwks?: ReturnType<typeof createRemoteJWKSet>
	private readonly pending = new Map<string, PendingAuthorization>()

	constructor(
		private readonly config: OidcAuthMode,
		private readonly readClientSecret: () => string | undefined,
	) {}

	start(request: Request, returnTo: string): Promise<Response> {
		return this.startAuthorization(request, returnTo)
	}

	async callback(request: Request): Promise<OidcCallbackResult> {
		const url = new URL(request.url)
		const state = url.searchParams.get('state') ?? ''
		const stateCookie = readCookie(request, STATE_COOKIE) ?? ''
		if (
			!/^[A-Za-z0-9_-]{43}$/.test(state) ||
			!/^[A-Za-z0-9_-]{43}$/.test(stateCookie) ||
			!equalText(state, stateCookie)
		) {
			return { ok: false, reason: 'invalid_credentials' }
		}
		const key = digest(state)
		const pending = this.pending.get(key)
		this.pending.delete(key)
		if (!pending || pending.expiresAt <= Date.now()) {
			return { ok: false, reason: 'invalid_credentials' }
		}
		const code = url.searchParams.get('code')
		if (!code || code.length > 4_096 || url.searchParams.has('error')) {
			return { ok: false, reason: 'invalid_credentials' }
		}

		try {
			const discovery = await this.discovery(request.signal)
			const body = new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: this.redirectUri,
				client_id: this.config.clientId,
				code_verifier: pending.verifier,
			})
			const headers = new Headers({
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			})
			if (this.config.clientKind === 'confidential') {
				const secret = this.readClientSecret()
				if (!secret) return { ok: false, reason: 'unavailable' }
				headers.set(
					'authorization',
					`Basic ${Buffer.from(`${this.config.clientId}:${secret}`).toString('base64')}`,
				)
			}
			const response = await fetch(discovery.tokenEndpoint, {
				method: 'POST',
				headers,
				body,
				signal: networkSignal(request.signal),
			})
			if (!response.ok) {
				return {
					ok: false,
					reason: response.status >= 500 ? 'unavailable' : 'invalid_credentials',
				}
			}
			const tokens = await boundedJson(response)
			if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 32_768) {
				return { ok: false, reason: 'invalid_credentials' }
			}
			const verified = await jwtVerify(tokens.id_token, await this.jwkSet(request.signal), {
				issuer: this.config.issuer,
				audience: this.config.clientId,
				clockTolerance: 5,
			})
			if (
				typeof verified.payload.nonce !== 'string' ||
				!equalText(verified.payload.nonce, pending.nonce) ||
				!authorizedPartyAllowed(verified.payload, this.config.clientId) ||
				!claimsAllowed(verified.payload, this.config.requiredClaims)
			) {
				return { ok: false, reason: 'invalid_credentials' }
			}
			const identity = principal(verified.payload, this.config.issuer)
			return identity
				? { ok: true, principal: identity, returnTo: pending.returnTo }
				: { ok: false, reason: 'invalid_credentials' }
		} catch (error) {
			return { ok: false, reason: verificationFailureReason(error) }
		}
	}

	async authorizeBearer(token: string, signal?: AbortSignal): Promise<AuthDecision> {
		if (!this.config.bearerAudience) return { allow: false, reason: 'unauthenticated' }
		if (token.length === 0 || token.length > 32_768) {
			return { allow: false, reason: 'invalid_credentials' }
		}
		try {
			const verified = await jwtVerify(token, await this.jwkSet(signal), {
				issuer: this.config.issuer,
				audience: this.config.bearerAudience,
				clockTolerance: 5,
			})
			if (!claimsAllowed(verified.payload, this.config.requiredClaims)) {
				return { allow: false, reason: 'forbidden' }
			}
			const identity = principal(verified.payload, this.config.issuer)
			return identity
				? { allow: true, principal: identity }
				: { allow: false, reason: 'invalid_credentials' }
		} catch (error) {
			return { allow: false, reason: verificationFailureReason(error) }
		}
	}

	clear(): void {
		this.pending.clear()
		this.discoveryTask = undefined
		this.jwks = undefined
	}

	stateClearCookie(): string {
		return `${STATE_COOKIE}=; Path=${CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
	}

	private async startAuthorization(request: Request, returnTo: string): Promise<Response> {
		const discovery = await this.discovery(request.signal)
		this.prunePending()
		while (this.pending.size >= MAX_PENDING) {
			const oldest = this.pending.keys().next().value as string | undefined
			if (!oldest) break
			this.pending.delete(oldest)
		}
		const state = randomToken()
		const verifier = randomToken()
		const nonce = randomToken()
		this.pending.set(
			digest(state),
			Object.freeze({ verifier, nonce, returnTo, expiresAt: Date.now() + PENDING_TTL_MS }),
		)
		const challenge = createHash('sha256').update(verifier).digest('base64url')
		const location = new URL(discovery.authorizationEndpoint)
		for (const [name, value] of Object.entries({
			client_id: this.config.clientId,
			response_type: 'code',
			scope: [...new Set(['openid', ...this.config.scopes])].join(' '),
			redirect_uri: this.redirectUri,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state,
			nonce,
		})) {
			location.searchParams.set(name, value)
		}
		return new Response(null, {
			status: 302,
			headers: {
				location: location.href,
				'cache-control': 'no-store',
				'set-cookie': `${STATE_COOKIE}=${state}; Path=${CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(PENDING_TTL_MS / 1_000)}`,
			},
		})
	}

	private get redirectUri(): string {
		return new URL(CALLBACK_PATH, this.config.publicOrigin).href
	}

	private discovery(signal?: AbortSignal): Promise<Discovery> {
		if (this.discoveryTask) return this.discoveryTask
		let task!: Promise<Discovery>
		task = this.fetchDiscovery(signal).catch((error: unknown) => {
			if (this.discoveryTask === task) this.discoveryTask = undefined
			throw error
		})
		this.discoveryTask = task
		return task
	}

	private async fetchDiscovery(signal?: AbortSignal): Promise<Discovery> {
		const issuer = this.config.issuer.replace(/\/+$/, '')
		const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
			headers: { accept: 'application/json' },
			signal: networkSignal(signal),
		})
		if (!response.ok) throw new Error('OIDC discovery failed')
		const metadata = await boundedJson(response)
		const authorizationEndpoint = endpoint(metadata.authorization_endpoint)
		const tokenEndpoint = endpoint(metadata.token_endpoint)
		const jwksUri = endpoint(metadata.jwks_uri)
		if (
			metadata.issuer !== this.config.issuer ||
			!authorizationEndpoint ||
			!tokenEndpoint ||
			!jwksUri
		) {
			throw new Error('Invalid OIDC discovery')
		}
		return Object.freeze({
			issuer: this.config.issuer,
			authorizationEndpoint,
			tokenEndpoint,
			jwksUri,
		})
	}

	private async jwkSet(signal?: AbortSignal): Promise<ReturnType<typeof createRemoteJWKSet>> {
		if (this.jwks) return this.jwks
		const discovery = await this.discovery(signal)
		this.jwks = createRemoteJWKSet(new URL(discovery.jwksUri), {
			timeoutDuration: NETWORK_TIMEOUT_MS,
			cooldownDuration: 30_000,
			cacheMaxAge: 10 * 60_000,
		})
		return this.jwks
	}

	private prunePending(): void {
		const now = Date.now()
		for (const [key, value] of this.pending) {
			if (value.expiresAt <= now) this.pending.delete(key)
		}
	}
}

export function readBearer(request: Request): string | undefined {
	const authorization = request.headers.get('authorization')
	if (!authorization || authorization.length > 32_800) return undefined
	const match = /^Bearer\s+(.+)$/i.exec(authorization)
	return match?.[1]
}
