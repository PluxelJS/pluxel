export const RUNTIME_INTERNAL_API_BASE = '/__pluxel/runtime' as const
export const RUNTIME_META_BASE = '/meta' as const
export const RUNTIME_EXTENSIONS_BASE = '/extensions' as const
export const RUNTIME_LOG_STREAMS_BASE = '/logs/v1/streams' as const
export const RUNTIME_EXTENSIONS_ARTIFACTS_BASE = `${RUNTIME_EXTENSIONS_BASE}/artifacts` as const
export const RUNTIME_VERIFICATION_BASE = '/__pluxel/verify' as const
export const RUNTIME_SECURITY_BASE = '/security' as const
export const RUNTIME_TRANSPORT_PATHS = {
	rpc: '/rpc',
	graphql: '/graphql',
	sse: '/sse',
	signaldb: '/signaldb',
} as const

export const RUNTIME_META_INFO_PATH = RUNTIME_META_BASE
export const RUNTIME_META_SSE_PATH = `${RUNTIME_META_BASE}/sse`
export const RUNTIME_SECURITY_EVENTS_PATH = `${RUNTIME_SECURITY_BASE}/events`
export const RUNTIME_SECURITY_VAULT_UNLOCK_PATH = `${RUNTIME_SECURITY_BASE}/vault/unlock`
export const RUNTIME_SECURITY_VAULT_HOST_KEY_PATH = `${RUNTIME_SECURITY_BASE}/vault/keys/host`
export const RUNTIME_SECURITY_VAULT_DEPLOY_GENERATE_PATH =
	`${RUNTIME_SECURITY_BASE}/vault/keys/deploy/generate`
export const RUNTIME_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH =
	`${RUNTIME_SECURITY_BASE}/vault/keys/deploy`
export const RUNTIME_EXTENSIONS_MANIFEST_PATH = `${RUNTIME_EXTENSIONS_BASE}/manifest`
export const RUNTIME_EXTENSIONS_EVENTS_PATH = `${RUNTIME_EXTENSIONS_BASE}/events`
export const RUNTIME_EXTENSIONS_MODULES_BASE = `${RUNTIME_EXTENSIONS_BASE}/modules`

export function joinPath(base: string, path: string): string {
	const safeBase = base.replace(/\/+$/, '')
	const safePath = path.startsWith('/') ? path : `/${path}`
	return `${safeBase}${safePath}`
}

export function runtimeExtensionModulePath(pluginName: string, file: string): string {
	return `${RUNTIME_EXTENSIONS_MODULES_BASE}/${encodeURIComponent(pluginName)}/${file}`
}

export function runtimeExtensionArtifactBasePath(pluginName: string, sourceHash: string): string {
	return `${RUNTIME_EXTENSIONS_ARTIFACTS_BASE}/${encodeURIComponent(pluginName)}/${encodeURIComponent(sourceHash)}`
}

export function runtimeExtensionArtifactPath(
	pluginName: string,
	sourceHash: string,
	file: string,
): string {
	const safeFile = file.startsWith('/') ? file.slice(1) : file
	return `${runtimeExtensionArtifactBasePath(pluginName, sourceHash)}/${safeFile}`
}

export function runtimeLogStreamPath(streamId: string, suffix = ''): string {
	return `${RUNTIME_LOG_STREAMS_BASE}/${encodeURIComponent(streamId)}${suffix}`
}

export function runtimeSignalDbCollectionPath(pluginName: string, collection: string): string {
	return `${RUNTIME_TRANSPORT_PATHS.signaldb}/${encodeURIComponent(pluginName)}/${encodeURIComponent(collection)}`
}
