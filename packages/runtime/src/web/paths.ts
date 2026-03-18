export const HMR_INTERNAL_API_BASE = '/__pluxel/hmr' as const
export const HMR_META_BASE = '/meta' as const
export const HMR_EXTENSIONS_BASE = '/extensions' as const
export const HMR_LOG_STREAMS_BASE = '/logs/v1/streams' as const
export const HMR_TRANSPORT_PATHS = {
	rpc: '/rpc',
	graphql: '/graphql',
	sse: '/sse',
	mcp: '/mcp',
} as const

export const HMR_META_INFO_PATH = HMR_META_BASE
export const HMR_META_AUTH_PATH = `${HMR_META_BASE}/auth`
export const HMR_META_SSE_PATH = `${HMR_META_BASE}/sse`
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

export function hmrLogStreamPath(streamId: string, suffix = ''): string {
	return `${HMR_LOG_STREAMS_BASE}/${encodeURIComponent(streamId)}${suffix}`
}
