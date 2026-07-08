import { RUNTIME_SECURITY_BASE, RUNTIME_VERIFICATION_BASE } from '../web/paths'
import type { ManagementAccessReason, ManagementAccessState } from '../services/verification/types'
export type { ManagementAccessReason, VerificationReason } from '../services/verification/types'

// Header names are part of the existing browser transport contract.
export const VERIFICATION_BLOCKED_HEADER = 'X-Pluxel-Verification-Blocked'
export const VERIFICATION_REDIRECT_HEADER = 'X-Pluxel-Verification-Redirect'
export const VERIFICATION_REASON_HEADER = 'X-Pluxel-Verification-Reason'

export type ManagementAccessBlockedKind = 'ui' | 'api' | 'graphql'
export type ManagementAccessBlockedCode = 'verification_blocked'

export type ManagementAccessBlockedPayload = {
	code: ManagementAccessBlockedCode
	kind: ManagementAccessBlockedKind
	path: string
	method: string
	redirectPath: string
	reason?: ManagementAccessReason
}
type BuildRedirectPath = (returnTo?: string) => string
type ManagementAccessLike = Pick<ManagementAccessState, 'allow' | 'reason'>

function requestReturnTo(request: Request): string {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}`
}

export function resolveManagementAccessLandingPath(reason?: ManagementAccessReason): string {
	return reason === 'missing_oidc' ? RUNTIME_SECURITY_BASE : RUNTIME_VERIFICATION_BASE
}

export function canAccessSecurityAdmin(state: ManagementAccessLike): boolean {
	return state.allow || state.reason === 'missing_oidc'
}

export function resolveManagementAccessRedirectPath(
	buildRedirectPath: BuildRedirectPath,
	request: Request,
	kind: ManagementAccessBlockedKind,
	reason?: ManagementAccessReason,
): string {
	if (reason === 'missing_oidc') return resolveManagementAccessLandingPath(reason)
	if (kind === 'ui') {
		return buildRedirectPath(requestReturnTo(request))
	}
	return resolveManagementAccessLandingPath(reason)
}

export function createManagementAccessBlockedPayload(
	path: string,
	method: string,
	kind: ManagementAccessBlockedKind,
	redirectPath: string,
	reason?: ManagementAccessReason,
): ManagementAccessBlockedPayload {
	return {
		code: 'verification_blocked',
		kind,
		path,
		method,
		redirectPath,
		reason,
	}
}

export function createManagementAccessBlockedHeaders(
	redirectPath: string,
	reason?: ManagementAccessReason,
): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		[VERIFICATION_BLOCKED_HEADER]: '1',
		[VERIFICATION_REDIRECT_HEADER]: redirectPath,
		...(reason ? { [VERIFICATION_REASON_HEADER]: reason } : {}),
	}
}

export type VerificationBlockedKind = ManagementAccessBlockedKind
export type VerificationBlockedCode = ManagementAccessBlockedCode
export type VerificationBlockedPayload = ManagementAccessBlockedPayload

export const resolveVerificationLandingPath = resolveManagementAccessLandingPath
export const resolveControlPlaneRedirectPath = resolveManagementAccessRedirectPath
export const createVerificationBlockedPayload = createManagementAccessBlockedPayload
export const createVerificationBlockedHeaders = createManagementAccessBlockedHeaders
