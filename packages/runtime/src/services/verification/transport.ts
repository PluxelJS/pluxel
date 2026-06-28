import { HMR_VERIFICATION_BASE } from '../../web/paths'

export const VERIFICATION_PAGE_PATH = HMR_VERIFICATION_BASE

export function buildVerificationRedirectPath(returnTo?: string): string {
	const search = new URLSearchParams()
	if (returnTo && returnTo !== VERIFICATION_PAGE_PATH) search.set('returnTo', returnTo)
	const query = search.toString()
	return query ? `${VERIFICATION_PAGE_PATH}?${query}` : VERIFICATION_PAGE_PATH
}
