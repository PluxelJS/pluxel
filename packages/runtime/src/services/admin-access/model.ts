import type {
	AdminAccessClaimRequirement,
	AdminAccessExposure,
	AdminAccessOidcConfig,
	ResolvedAdminAccessConfig,
} from './types'

export const DEFAULT_ADMIN_ACCESS_EXPOSURE = 'private' as const
export const DEFAULT_OIDC_TOKEN_HEADER = 'authorization' as const

type AdminAccessConfigLike =
	| {
			enabled?: unknown
			exposure?: unknown
			oidc?: unknown
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

function normalizeClaimRequirement(value: unknown): AdminAccessClaimRequirement | undefined {
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
): Record<string, AdminAccessClaimRequirement> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const claims: Record<string, AdminAccessClaimRequirement> = {}
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

function normalizeOidcConfig(value: unknown): AdminAccessOidcConfig | undefined {
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

export function resolveAdminAccessConfig(input?: AdminAccessConfigLike): ResolvedAdminAccessConfig {
	const enabled = input?.enabled === true
	const exposure: AdminAccessExposure =
		input?.exposure === 'public' ? 'public' : DEFAULT_ADMIN_ACCESS_EXPOSURE
	const oidc = normalizeOidcConfig(input?.oidc)
	if (!enabled) {
		return {
			enabled: false,
			exposure: 'private',
		}
	}
	return {
		enabled,
		exposure,
		...(oidc ? { oidc } : {}),
	}
}
