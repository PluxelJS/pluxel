import type { JWTPayload } from 'jose'

export type AdminAccessExposure = 'private' | 'public'

export type AdminAccessClaimRequirement = string | string[]

export type AdminAccessOidcConfig = {
	issuer: string
	audience?: string | string[]
	tokenHeader?: string
	/**
	 * Claims required for Pluxel admin access.
	 *
	 * Pluxel has no separate non-admin user model; a token that satisfies this
	 * policy is allowed to enter the workbench surface as an admin.
	 */
	requiredClaims?: Record<string, AdminAccessClaimRequirement>
	clockToleranceSeconds?: number
}

export type AdminAccessConfig =
	| {
			exposure?: 'private'
			oidc?: AdminAccessOidcConfig
	  }
	| {
			exposure: 'public'
			oidc: AdminAccessOidcConfig
	  }

export type ResolvedAdminAccessConfig = {
	exposure: AdminAccessExposure
	oidc?: AdminAccessOidcConfig
}

export type AdminAccessReason =
	| 'private'
	| 'missing_oidc'
	| 'unauthenticated'
	| 'invalid_token'
	| 'forbidden'

export type AdminAccessPrincipal = {
	provider: 'oidc'
	subject: string
	claims: JWTPayload
}

export type AdminAccessRequestContext = {
	request?: Request
	headers?: Headers
	url?: string
}

export type AdminAccessAuthorizeInput = AdminAccessRequestContext

export type AdminAccessState = {
	allow: boolean
	reason?: AdminAccessReason
	principal?: AdminAccessPrincipal
}

export type AdminAccessOverview = {
	exposure: AdminAccessExposure
	provider: 'none' | 'oidc'
	issuer?: string
	audience?: string | string[]
	requiredClaims?: Record<string, AdminAccessClaimRequirement>
	tokenHeader?: string
} & AdminAccessState
