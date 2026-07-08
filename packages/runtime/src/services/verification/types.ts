import type { JWTPayload } from 'jose'

export type ManagementAccessExposure = 'private' | 'public'

export type ManagementAccessClaimRequirement = string | string[]

export type ManagementAccessOidcConfig = {
	issuer: string
	audience?: string | string[]
	tokenHeader?: string
	/**
	 * Claims required for Pluxel management admin access.
	 *
	 * Pluxel has no separate non-admin user model; a token that satisfies this
	 * policy is allowed to enter the management surface as an admin.
	 */
	requiredClaims?: Record<string, ManagementAccessClaimRequirement>
	clockToleranceSeconds?: number
}

export type ManagementAccessConfig =
	| {
			exposure?: 'private'
			oidc?: ManagementAccessOidcConfig
	  }
	| {
			exposure: 'public'
			oidc?: ManagementAccessOidcConfig
	  }

export type ManagementConfig = {
	enabled?: boolean
	access?: ManagementAccessConfig
}

export type ManagementAccessReason =
	| 'private'
	| 'missing_oidc'
	| 'unauthenticated'
	| 'invalid_token'
	| 'forbidden'

export type ManagementAccessPrincipal = {
	provider: 'oidc'
	subject: string
	claims: JWTPayload
}

export type ManagementAccessRequestContext = {
	request?: Request
	headers?: Headers
	url?: string
}

export type ManagementAccessAuthorizeInput = ManagementAccessRequestContext

export type ManagementAccessState = {
	allow: boolean
	reason?: ManagementAccessReason
	principal?: ManagementAccessPrincipal
}

export type ManagementAccessOverview = {
	exposure: ManagementAccessExposure
	provider: 'none' | 'oidc'
	issuer?: string
	audience?: string | string[]
	requiredClaims?: Record<string, ManagementAccessClaimRequirement>
	tokenHeader?: string
} & ManagementAccessState

export type VerificationExposure = ManagementAccessExposure
export type VerificationClaimRequirement = ManagementAccessClaimRequirement
export type VerificationOidcConfig = ManagementAccessOidcConfig
export type VerificationReason = ManagementAccessReason
export type VerificationPrincipal = ManagementAccessPrincipal
export type VerificationRequestContext = ManagementAccessRequestContext
export type VerificationAuthorizeInput = ManagementAccessAuthorizeInput
export type VerificationState = ManagementAccessState
export type VerificationOverview = ManagementAccessOverview
