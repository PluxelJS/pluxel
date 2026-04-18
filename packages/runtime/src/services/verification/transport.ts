import { HMR_VERIFICATION_BASE } from '../../web/paths'

export const VERIFICATION_PAGE_PATH = HMR_VERIFICATION_BASE
export const VERIFICATION_COOKIE_NAME = 'pluxel-verify'
export const VERIFICATION_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function buildVerificationRedirectPath(returnTo?: string): string {
	const search = new URLSearchParams()
	if (returnTo && returnTo !== VERIFICATION_PAGE_PATH) search.set('returnTo', returnTo)
	const query = search.toString()
	return query ? `${VERIFICATION_PAGE_PATH}?${query}` : VERIFICATION_PAGE_PATH
}
