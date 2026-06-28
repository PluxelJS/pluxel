export const HMR_INTERNAL_API_BASE = '/__pluxel/hmr' as const
export const HMR_META_BASE = '/meta' as const
export const HMR_EXTENSIONS_BASE = '/extensions' as const
export const HMR_LOG_STREAMS_BASE = '/logs/v1/streams' as const
export const HMR_EXTENSIONS_ARTIFACTS_BASE = `${HMR_EXTENSIONS_BASE}/artifacts` as const
export const HMR_VERIFICATION_BASE = '/__pluxel/verify' as const
export const HMR_SECURITY_BASE = '/security' as const
export const HMR_TRANSPORT_PATHS = {
	rpc: '/rpc',
	graphql: '/graphql',
	sse: '/sse',
	signaldb: '/signaldb',
} as const

export const HMR_META_INFO_PATH = HMR_META_BASE
export const HMR_META_SSE_PATH = `${HMR_META_BASE}/sse`
export const HMR_SECURITY_EVENTS_PATH = `${HMR_SECURITY_BASE}/events`
export const HMR_SECURITY_VAULT_UNLOCK_PATH = `${HMR_SECURITY_BASE}/vault/unlock`
export const HMR_SECURITY_VAULT_HOST_KEY_PATH = `${HMR_SECURITY_BASE}/vault/keys/host`
export const HMR_SECURITY_VAULT_DEPLOY_GENERATE_PATH =
	`${HMR_SECURITY_BASE}/vault/keys/deploy/generate`
export const HMR_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH =
	`${HMR_SECURITY_BASE}/vault/keys/deploy`
export const HMR_EXTENSIONS_MANIFEST_PATH = `${HMR_EXTENSIONS_BASE}/manifest`
export const HMR_EXTENSIONS_EVENTS_PATH = `${HMR_EXTENSIONS_BASE}/events`
export const HMR_EXTENSIONS_MODULES_BASE = `${HMR_EXTENSIONS_BASE}/modules`

export function joinPath(base: string, path: string): string {
	const safeBase = base.replace(/\/+$/, '')
	const safePath = path.startsWith('/') ? path : `/${path}`
	return `${safeBase}${safePath}`
}

export function hmrExtensionModulePath(pluginName: string, file: string): string {
	return `${HMR_EXTENSIONS_MODULES_BASE}/${encodeURIComponent(pluginName)}/${file}`
}

export function hmrExtensionArtifactBasePath(pluginName: string, sourceHash: string): string {
	return `${HMR_EXTENSIONS_ARTIFACTS_BASE}/${encodeURIComponent(pluginName)}/${encodeURIComponent(sourceHash)}`
}

export function hmrExtensionArtifactPath(
	pluginName: string,
	sourceHash: string,
	file: string,
): string {
	const safeFile = file.startsWith('/') ? file.slice(1) : file
	return `${hmrExtensionArtifactBasePath(pluginName, sourceHash)}/${safeFile}`
}

export function hmrLogStreamPath(streamId: string, suffix = ''): string {
	return `${HMR_LOG_STREAMS_BASE}/${encodeURIComponent(streamId)}${suffix}`
}

export function hmrSignalDbCollectionPath(pluginName: string, collection: string): string {
	return `${HMR_TRANSPORT_PATHS.signaldb}/${encodeURIComponent(pluginName)}/${encodeURIComponent(collection)}`
}
