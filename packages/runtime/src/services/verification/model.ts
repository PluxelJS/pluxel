import type {
	ManagementAccessConfig,
	ManagementConfig,
	VerificationClaimRequirement,
	VerificationExposure,
	VerificationOidcConfig,
} from './types'

export const DEFAULT_VERIFICATION_EXPOSURE = 'private' as const
export const DEFAULT_OIDC_TOKEN_HEADER = 'authorization' as const

type ManagementAccessConfigLike =
	| {
			exposure?: unknown
			oidc?: unknown
	  }
	| null
	| undefined

type ManagementConfigLike =
	| {
			enabled?: unknown
			access?: ManagementAccessConfigLike
	  }
	| null
	| undefined

function trimOrUndefined(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}

function normalizeAudience(value: unknown): string | string[] | undefined {
	if (typeof value === 'string') return trimOrUndefined(value)
	if (!Array.isArray(value)) return undefined
	const seen = new Set<string>()
	const audience: string[] = []
	for (const entry of value) {
		const item = trimOrUndefined(entry)
		if (!item || seen.has(item)) continue
		seen.add(item)
		audience.push(item)
	}
	return audience.length > 0 ? audience : undefined
}

function normalizeClaimRequirement(value: unknown): VerificationClaimRequirement | undefined {
	if (typeof value === 'string') return trimOrUndefined(value)
	if (!Array.isArray(value)) return undefined
	const seen = new Set<string>()
	const values: string[] = []
	for (const entry of value) {
		const item = trimOrUndefined(entry)
		if (!item || seen.has(item)) continue
		seen.add(item)
		values.push(item)
	}
	return values.length > 0 ? values : undefined
}

function normalizeRequiredClaims(
	value: unknown,
): Record<string, VerificationClaimRequirement> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const claims: Record<string, VerificationClaimRequirement> = {}
	for (const [key, raw] of Object.entries(value)) {
		const name = key.trim()
		const requirement = normalizeClaimRequirement(raw)
		if (!name || !requirement) continue
		claims[name] = requirement
	}
	return Object.keys(claims).length > 0 ? claims : undefined
}

function normalizeClockTolerance(value: unknown): number | undefined {
	const seconds = Number(value)
	if (!Number.isFinite(seconds) || seconds < 0) return undefined
	return Math.floor(seconds)
}

function normalizeOidcConfig(value: unknown): VerificationOidcConfig | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const source = value as {
		issuer?: unknown
		audience?: unknown
		tokenHeader?: unknown
		requiredClaims?: unknown
		clockToleranceSeconds?: unknown
	}
	const issuer = trimOrUndefined(source.issuer)?.replace(/\/+$/, '')
	if (!issuer) return undefined
	const audience = normalizeAudience(source.audience)
	const tokenHeader = trimOrUndefined(source.tokenHeader)?.toLowerCase()
	const requiredClaims = normalizeRequiredClaims(source.requiredClaims)
	const clockToleranceSeconds = normalizeClockTolerance(source.clockToleranceSeconds)
	return {
		issuer,
		...(audience ? { audience } : {}),
		...(tokenHeader ? { tokenHeader } : {}),
		...(requiredClaims ? { requiredClaims } : {}),
		...(clockToleranceSeconds !== undefined ? { clockToleranceSeconds } : {}),
	}
}

function resolveManagementAccessConfig(input?: ManagementAccessConfigLike): ManagementAccessConfig {
	const exposure: VerificationExposure =
		input?.exposure === 'public' ? 'public' : DEFAULT_VERIFICATION_EXPOSURE
	const oidc = normalizeOidcConfig(input?.oidc)
	if (exposure === 'private') {
		return {
			exposure: 'private',
			...(oidc ? { oidc } : {}),
		}
	}
	return {
		exposure: 'public',
		...(oidc ? { oidc } : {}),
	}
}

export function resolveManagementConfig(input?: ManagementConfigLike): Required<ManagementConfig> {
	return {
		enabled: input?.enabled === true,
		access: resolveManagementAccessConfig(input?.access),
	}
}
