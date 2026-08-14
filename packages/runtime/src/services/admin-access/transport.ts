import { RUNTIME_ADMIN_ACCESS_BASE } from '../../web/paths'

export const ADMIN_ACCESS_PAGE_PATH = RUNTIME_ADMIN_ACCESS_BASE

export function buildAdminAccessRedirectPath(returnTo?: string): string {
	const search = new URLSearchParams()
	if (returnTo && returnTo !== ADMIN_ACCESS_PAGE_PATH) search.set('returnTo', returnTo)
	const query = search.toString()
	return query ? `${ADMIN_ACCESS_PAGE_PATH}?${query}` : ADMIN_ACCESS_PAGE_PATH
}
