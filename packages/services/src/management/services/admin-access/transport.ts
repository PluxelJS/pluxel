import { RUNTIME_ADMIN_ACCESS_BASE } from '../../web/paths'

export const ADMIN_ACCESS_OIDC_START_PATH = `${RUNTIME_ADMIN_ACCESS_BASE}/oidc/start` as const
export const ADMIN_ACCESS_OIDC_CALLBACK_PATH = `${RUNTIME_ADMIN_ACCESS_BASE}/oidc/callback` as const
export const ADMIN_ACCESS_COOKIE_COMMIT_PATH = `${RUNTIME_ADMIN_ACCESS_BASE}/cookie/commit` as const

export function isAdminAccessHandoffPath(path: string): boolean {
	return (
		path === ADMIN_ACCESS_OIDC_START_PATH ||
		path === ADMIN_ACCESS_OIDC_CALLBACK_PATH ||
		path === ADMIN_ACCESS_COOKIE_COMMIT_PATH
	)
}
