import { RUNTIME_ADMIN_ACCESS_BASE, RUNTIME_SECURITY_BASE } from '../web/paths'
import type { AdminAccessReason, AdminAccessState } from '../services/admin-access/types'
export type { AdminAccessReason } from '../services/admin-access/types'

export const ADMIN_ACCESS_BLOCKED_HEADER = 'X-Pluxel-Admin-Access-Blocked'
export const ADMIN_ACCESS_REDIRECT_HEADER = 'X-Pluxel-Admin-Access-Redirect'
export const ADMIN_ACCESS_REASON_HEADER = 'X-Pluxel-Admin-Access-Reason'

export type AdminAccessBlockedKind = 'ui' | 'api' | 'graphql'
export type AdminAccessBlockedCode = 'admin_access_blocked'

export type AdminAccessBlockedPayload = {
	code: AdminAccessBlockedCode
	kind: AdminAccessBlockedKind
	path: string
	method: string
	redirectPath: string
	reason?: AdminAccessReason
}
type BuildRedirectPath = (returnTo?: string) => string
type AdminAccessLike = Pick<AdminAccessState, 'allow' | 'reason'>

function requestReturnTo(request: Request): string {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}`
}

export function resolveAdminAccessLandingPath(reason?: AdminAccessReason): string {
	return reason === 'missing_oidc' ? RUNTIME_SECURITY_BASE : RUNTIME_ADMIN_ACCESS_BASE
}

export function canAccessSecurityAdmin(state: AdminAccessLike): boolean {
	return state.allow || state.reason === 'missing_oidc'
}

export function resolveAdminAccessRedirectPath(
	buildRedirectPath: BuildRedirectPath,
	request: Request,
	kind: AdminAccessBlockedKind,
	reason?: AdminAccessReason,
): string {
	if (reason === 'missing_oidc') return resolveAdminAccessLandingPath(reason)
	if (kind === 'ui') {
		return buildRedirectPath(requestReturnTo(request))
	}
	return resolveAdminAccessLandingPath(reason)
}

export function createAdminAccessBlockedPayload(
	path: string,
	method: string,
	kind: AdminAccessBlockedKind,
	redirectPath: string,
	reason?: AdminAccessReason,
): AdminAccessBlockedPayload {
	return {
		code: 'admin_access_blocked',
		kind,
		path,
		method,
		redirectPath,
		reason,
	}
}

export function createAdminAccessBlockedHeaders(
	redirectPath: string,
	reason?: AdminAccessReason,
): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		[ADMIN_ACCESS_BLOCKED_HEADER]: '1',
		[ADMIN_ACCESS_REDIRECT_HEADER]: redirectPath,
		...(reason ? { [ADMIN_ACCESS_REASON_HEADER]: reason } : {}),
	}
}
