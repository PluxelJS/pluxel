import { RUNTIME_ADMIN_ACCESS_BASE } from '../web/paths'
import type { AdminAccessReason } from '../services/admin-access/types'
export type { AdminAccessReason } from '../services/admin-access/types'

export const ADMIN_ACCESS_BLOCKED_HEADER = 'X-Pluxel-Admin-Access-Blocked'
export const ADMIN_ACCESS_REDIRECT_HEADER = 'X-Pluxel-Admin-Access-Redirect'
export const ADMIN_ACCESS_REASON_HEADER = 'X-Pluxel-Admin-Access-Reason'

export type AdminAccessBlockedKind = 'ui' | 'api'
export type AdminAccessBlockedCode =
	| 'management_authentication_required'
	| 'management_local_setup_required'
	| 'management_forbidden'
	| 'management_authentication_unavailable'

export type AdminAccessBlockedPayload = {
	code: AdminAccessBlockedCode
	kind: AdminAccessBlockedKind
	path: string
	method: string
	redirectPath: string
	reason: AdminAccessReason
	status: 401 | 403 | 503
}
type BuildRedirectPath = (returnTo?: string) => string
type AdminAccessLike = { allow: boolean; reason?: AdminAccessReason }

function requestReturnTo(request: Request): string {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}`
}

export function resolveAdminAccessLandingPath(_reason?: AdminAccessReason): string {
	return RUNTIME_ADMIN_ACCESS_BASE
}

export function canAccessSecurityAdmin(state: AdminAccessLike): boolean {
	return state.allow
}

export function resolveAdminAccessRedirectPath(
	buildRedirectPath: BuildRedirectPath,
	request: Request,
	kind: AdminAccessBlockedKind,
	reason?: AdminAccessReason,
): string {
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
	reason: AdminAccessReason,
): AdminAccessBlockedPayload {
	const { code, status } = blockedProtocol(reason)
	return {
		code,
		kind,
		path,
		method,
		redirectPath,
		reason,
		status,
	}
}

export function createAdminAccessBlockedHeaders(
	redirectPath: string,
	reason: AdminAccessReason,
): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		[ADMIN_ACCESS_BLOCKED_HEADER]: '1',
		[ADMIN_ACCESS_REDIRECT_HEADER]: redirectPath,
		[ADMIN_ACCESS_REASON_HEADER]: reason,
	}
}

function blockedProtocol(reason: AdminAccessReason): Readonly<{
	code: AdminAccessBlockedCode
	status: 401 | 403 | 503
}> {
	switch (reason) {
		case 'local_setup_required':
			return { code: 'management_local_setup_required', status: 403 }
		case 'authentication_unavailable':
			return { code: 'management_authentication_unavailable', status: 503 }
		case 'forbidden':
		case 'secure_transport_required':
			return { code: 'management_forbidden', status: 403 }
		case 'authentication_required':
		case 'invalid_credentials':
			return { code: 'management_authentication_required', status: 401 }
	}
}
