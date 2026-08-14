import { type Context as PluxelContext, RootService } from '@pluxel/core'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { recordSecurityEvent } from '../security/audit'
import { DEFAULT_OIDC_TOKEN_HEADER, resolveAdminAccessConfig } from './model'
import type {
	AdminAccessAuthorizeInput,
	AdminAccessClaimRequirement,
	AdminAccessOidcConfig,
	AdminAccessOverview,
	AdminAccessState,
	ResolvedAdminAccessConfig,
} from './types'

const serviceName = 'adminAccess' as const

type OidcDiscovery = {
	issuer: string
	jwks_uri: string
}

const discoveryCache = new Map<string, Promise<OidcDiscovery>>()
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

declare module '@pluxel/core' {
	namespace Context {
		interface RootServices {
			[serviceName]: AdminAccessService
		}
	}
}

function readHeaders(input: AdminAccessAuthorizeInput): Headers {
	return input.headers ?? input.request?.headers ?? new Headers()
}

function readBearerToken(
	headers: Headers,
	headerName: string = DEFAULT_OIDC_TOKEN_HEADER,
): string | undefined {
	const raw = headers.get(headerName)
	if (!raw) return undefined
	const value = raw.trim()
	if (!value) return undefined
	if (headerName.toLowerCase() === 'authorization') {
		const [scheme, token] = value.split(/\s+/, 2)
		return scheme?.toLowerCase() === 'bearer' && token ? token : undefined
	}
	return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : value
}

function claimValues(value: unknown): string[] {
	if (typeof value === 'string') return [value]
	if (!Array.isArray(value)) return []
	return value.filter((entry): entry is string => typeof entry === 'string')
}

function claimMatches(actual: unknown, expected: AdminAccessClaimRequirement): boolean {
	const actualValues = claimValues(actual)
	const expectedValues = Array.isArray(expected) ? expected : [expected]
	return expectedValues.some((entry) => actualValues.includes(entry))
}

function claimsMatch(
	payload: JWTPayload,
	requiredClaims: Record<string, AdminAccessClaimRequirement>,
): boolean {
	for (const [name, expected] of Object.entries(requiredClaims)) {
		if (!claimMatches(payload[name], expected)) return false
	}
	return true
}

async function fetchOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
	const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
		headers: { accept: 'application/json' },
	})
	if (!response.ok) throw new Error(`OIDC discovery failed for ${issuer}`)
	const body = (await response.json()) as Partial<OidcDiscovery>
	if (body.issuer !== issuer || typeof body.jwks_uri !== 'string' || !body.jwks_uri.trim()) {
		throw new Error(`OIDC discovery is invalid for ${issuer}`)
	}
	return {
		issuer: body.issuer,
		jwks_uri: body.jwks_uri,
	}
}

async function resolveJwks(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
	let discoveryPromise = discoveryCache.get(issuer)
	if (!discoveryPromise) {
		discoveryPromise = fetchOidcDiscovery(issuer)
		discoveryCache.set(issuer, discoveryPromise)
		discoveryPromise.catch(() => {
			if (discoveryCache.get(issuer) === discoveryPromise) discoveryCache.delete(issuer)
		})
	}
	const discovery = await discoveryPromise
	let jwks = jwksCache.get(discovery.jwks_uri)
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(discovery.jwks_uri))
		jwksCache.set(discovery.jwks_uri, jwks)
	}
	return jwks
}

@RootService({ key: serviceName })
export class AdminAccessService {
	constructor(public ctx: PluxelContext) {}

	async authorize(input: AdminAccessAuthorizeInput = {}): Promise<AdminAccessState> {
		const config = this.readConfig()
		if (config.exposure !== 'public') {
			return {
				allow: true,
				reason: 'private',
			}
		}
		if (!config.oidc) return { allow: false, reason: 'missing_oidc' }

		const token = readBearerToken(readHeaders(input), config.oidc.tokenHeader)
		if (!token) return { allow: false, reason: 'unauthenticated' }

		return await this.verifyOidcToken(config.oidc, token)
	}

	async describe(input: AdminAccessAuthorizeInput = {}): Promise<AdminAccessOverview> {
		const config = this.readConfig()
		const state = await this.authorize(input)
		return {
			exposure: config.exposure ?? 'private',
			provider: config.exposure === 'public' ? 'oidc' : 'none',
			...(config.exposure === 'public' && config.oidc
				? {
						issuer: config.oidc.issuer,
						audience: config.oidc.audience,
						requiredClaims: config.oidc.requiredClaims,
						tokenHeader: config.oidc.tokenHeader ?? DEFAULT_OIDC_TOKEN_HEADER,
					}
				: {}),
			...state,
		}
	}

	private async verifyOidcToken(
		config: AdminAccessOidcConfig,
		token: string,
	): Promise<AdminAccessState> {
		try {
			const jwks = await resolveJwks(config.issuer)
			const result = await jwtVerify(token, jwks, {
				issuer: config.issuer,
				...(config.audience ? { audience: config.audience } : {}),
				clockTolerance: config.clockToleranceSeconds ?? 5,
			})
			if (config.requiredClaims && !claimsMatch(result.payload, config.requiredClaims)) {
				recordSecurityEvent(this.ctx, {
					area: 'adminAccess',
					action: 'authorize',
					status: 'failure',
					reason: 'forbidden',
					message: 'OIDC token did not satisfy required claims.',
				})
				return { allow: false, reason: 'forbidden' }
			}
			if (!result.payload.sub) return { allow: false, reason: 'invalid_token' }
			return {
				allow: true,
				principal: {
					provider: 'oidc',
					subject: result.payload.sub,
					claims: result.payload,
				},
			}
		} catch (error) {
			recordSecurityEvent(this.ctx, {
				area: 'adminAccess',
				action: 'authorize',
				status: 'failure',
				reason: 'invalid_token',
				message: error instanceof Error ? error.message : 'OIDC token check failed.',
			})
			return { allow: false, reason: 'invalid_token' }
		}
	}

	private readConfig(): ResolvedAdminAccessConfig {
		const config = this.ctx.config as { adminAccess?: unknown }
		return resolveAdminAccessConfig(config.adminAccess)
	}
}
