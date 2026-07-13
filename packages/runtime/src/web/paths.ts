export const RUNTIME_INTERNAL_API_BASE = '/__pluxel/runtime' as const
export const UI_PUBLIC_BASE = '/dist/public' as const
export const RUNTIME_META_BASE = '/meta' as const
export const RUNTIME_LOG_STREAMS_BASE = '/logs/v1/streams' as const
export const RUNTIME_ADMIN_ACCESS_BASE = '/__pluxel/admin-access' as const
export const RUNTIME_SECURITY_BASE = '/security' as const
export const RUNTIME_TRANSPORT_PATHS = {
	rpc: '/rpc',
	graphql: '/graphql',
	sse: '/sse',
} as const

export const RUNTIME_META_INFO_PATH = RUNTIME_META_BASE
export const RUNTIME_META_SSE_PATH = `${RUNTIME_META_BASE}/sse`
export const RUNTIME_SECURITY_EVENTS_PATH = `${RUNTIME_SECURITY_BASE}/events`
export const RUNTIME_SECURITY_VAULT_UNLOCK_PATH = `${RUNTIME_SECURITY_BASE}/vault/unlock`
export const RUNTIME_SECURITY_VAULT_HOST_KEY_PATH = `${RUNTIME_SECURITY_BASE}/vault/keys/host`
export const RUNTIME_SECURITY_VAULT_DEPLOY_GENERATE_PATH = `${RUNTIME_SECURITY_BASE}/vault/keys/deploy/generate`
export const RUNTIME_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH = `${RUNTIME_SECURITY_BASE}/vault/keys/deploy`
export const RUNTIME_MANAGEMENT_BASE = '/management' as const
export const RUNTIME_MANAGEMENT_ARTIFACTS_BASE = `${RUNTIME_MANAGEMENT_BASE}/artifacts` as const
export const RUNTIME_MANAGEMENT_CATALOG_PATH = `${RUNTIME_MANAGEMENT_BASE}/catalog` as const
export const RUNTIME_MANAGEMENT_GLOBAL_LAYOUT_PATH =
	`${RUNTIME_MANAGEMENT_BASE}/layout/global` as const
export const RUNTIME_MANAGEMENT_PLUGIN_LAYOUT_BASE =
	`${RUNTIME_MANAGEMENT_BASE}/layout/plugin` as const
export const RUNTIME_MANAGEMENT_EVENTS_PATH = `${RUNTIME_MANAGEMENT_BASE}/events` as const
export const RUNTIME_MANAGEMENT_RESOURCES_BASE = `${RUNTIME_MANAGEMENT_BASE}/resources` as const

export function joinPath(base: string, path: string): string {
	const safeBase = base.replace(/\/+$/, '')
	const safePath = path.startsWith('/') ? path : `/${path}`
	return `${safeBase}${safePath}`
}

export function runtimeManagementArtifactBasePath(owner: string, sourceHash: string): string {
	return `${RUNTIME_MANAGEMENT_ARTIFACTS_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(sourceHash)}`
}

export function runtimeManagementArtifactPath(
	owner: string,
	sourceHash: string,
	file: string,
): string {
	return `${runtimeManagementArtifactBasePath(owner, sourceHash)}/${file.replace(/^\/+/, '')}`
}

export function runtimeLogStreamPath(streamId: string, suffix = ''): string {
	return `${RUNTIME_LOG_STREAMS_BASE}/${encodeURIComponent(streamId)}${suffix}`
}

export function runtimeManagementCollectionPath(binding: string): string {
	return `${RUNTIME_MANAGEMENT_RESOURCES_BASE}/collection/${encodeURIComponent(binding)}`
}

export function runtimeManagementStreamPath(binding: string): string {
	return `${RUNTIME_MANAGEMENT_RESOURCES_BASE}/stream/${encodeURIComponent(binding)}`
}
