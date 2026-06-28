import { HMR_SECURITY_BASE, HMR_VERIFICATION_BASE } from '../web/paths'
import type { VerificationReason, VerificationState } from '../services/verification/types'
export type { VerificationReason } from '../services/verification/types'

export const VERIFICATION_BLOCKED_HEADER = 'X-Pluxel-Verification-Blocked'
export const VERIFICATION_REDIRECT_HEADER = 'X-Pluxel-Verification-Redirect'
export const VERIFICATION_REASON_HEADER = 'X-Pluxel-Verification-Reason'

export type VerificationBlockedKind = 'ui' | 'api' | 'graphql'
export type VerificationBlockedCode = 'verification_blocked'

export type VerificationBlockedPayload = {
	code: VerificationBlockedCode
	kind: VerificationBlockedKind
	path: string
	method: string
	redirectPath: string
	reason?: VerificationReason
}
type BuildRedirectPath = (returnTo?: string) => string
type VerificationLike = Pick<VerificationState, 'allow' | 'reason'>

function requestReturnTo(request: Request): string {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}`
}

export function resolveVerificationLandingPath(reason?: VerificationReason): string {
	return reason === 'missing_oidc' ? HMR_SECURITY_BASE : HMR_VERIFICATION_BASE
}

export function canAccessSecurityAdmin(state: VerificationLike): boolean {
	return state.allow || state.reason === 'missing_oidc'
}

export function resolveControlPlaneRedirectPath(
	buildRedirectPath: BuildRedirectPath,
	request: Request,
	kind: VerificationBlockedKind,
	reason?: VerificationReason,
): string {
	if (reason === 'missing_oidc') return resolveVerificationLandingPath(reason)
	if (kind === 'ui') {
		return buildRedirectPath(requestReturnTo(request))
	}
	return resolveVerificationLandingPath(reason)
}

export function createVerificationBlockedPayload(
	path: string,
	method: string,
	kind: VerificationBlockedKind,
	redirectPath: string,
	reason?: VerificationReason,
): VerificationBlockedPayload {
	return {
		code: 'verification_blocked',
		kind,
		path,
		method,
		redirectPath,
		reason,
	}
}

export function createVerificationBlockedHeaders(
	redirectPath: string,
	reason?: VerificationReason,
): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		[VERIFICATION_BLOCKED_HEADER]: '1',
		[VERIFICATION_REDIRECT_HEADER]: redirectPath,
		...(reason ? { [VERIFICATION_REASON_HEADER]: reason } : {}),
	}
}
