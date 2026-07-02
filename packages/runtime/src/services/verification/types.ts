import type { JWTPayload } from 'jose'

export type VerificationExposure = 'private' | 'public'

export type VerificationClaimRequirement = string | string[]

export type VerificationOidcConfig = {
	issuer: string
	audience?: string | string[]
	tokenHeader?: string
	requiredClaims?: Record<string, VerificationClaimRequirement>
	clockToleranceSeconds?: number
}

export type ManagementAccessConfig =
	| {
			exposure?: 'private'
			oidc?: VerificationOidcConfig
	  }
	| {
			exposure: 'public'
			oidc?: VerificationOidcConfig
	  }

export type ManagementConfig = {
	enabled?: boolean
	access?: ManagementAccessConfig
}

export type VerificationReason =
	| 'private'
	| 'missing_oidc'
	| 'unauthenticated'
	| 'invalid_token'
	| 'forbidden'

export type VerificationPrincipal = {
	subject: string
	claims: JWTPayload
}

export type VerificationRequestContext = {
	request?: Request
	headers?: Headers
	url?: string
}

export type VerificationAuthorizeInput = VerificationRequestContext

export type VerificationState = {
	allow: boolean
	reason?: VerificationReason
	principal?: VerificationPrincipal
}

export type VerificationOverview = {
	exposure: VerificationExposure
	provider: 'none' | 'oidc'
	issuer?: string
	audience?: string | string[]
	requiredClaims?: Record<string, VerificationClaimRequirement>
	tokenHeader?: string
} & VerificationState
