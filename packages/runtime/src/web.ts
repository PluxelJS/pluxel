export {
	type AuthAwareFetchOptions,
	type AuthBlockedInfo,
	type HmrFetch,
	createAuthAwareFetch,
	defaultOnAuthBlocked,
	type OnAuthBlocked,
} from './web/auth'

export {
	createHmrFetch,
	createHmrTransport,
	createHmrWebClient,
	expectData,
	type HmrAuthMeta,
	type HmrHttpApi,
	type HmrInternalMeta,
	type HmrLogRangeQuery,
	type HmrStreamIndex,
	type HmrTransportLinks,
	type HmrWebClient,
	type HmrWebClientOptions,
} from './web/client'
export type {
	LogFilter,
	LogRangeErr,
	LogRangeOk,
	LogRangeResult,
	LogSseAppend,
	LogSseEvent,
	LogSseGap,
	LogSseReset,
	LogStreamMeta,
	RuntimeLogError,
	RuntimeLogLine,
} from './web/logs'
export {
	HMR_EXTENSIONS_BASE,
	HMR_EXTENSIONS_EVENTS_PATH,
	HMR_EXTENSIONS_MANIFEST_PATH,
	HMR_EXTENSIONS_MODULES_BASE,
	HMR_INTERNAL_API_BASE,
	HMR_LOG_STREAMS_BASE,
	HMR_META_AUTH_PATH,
	HMR_META_BASE,
	HMR_META_INFO_PATH,
	HMR_META_SSE_PATH,
	HMR_TRANSPORT_PATHS,
	hmrExtensionModulePath,
	hmrLogStreamPath,
	joinPath,
} from './web/paths'
export * from './web/plugin-ui/types'
export { extensionVendorPackages, type ExtensionVendorPackage } from './web/plugin-ui/vendors'
export * from './web/protocol'
export { HmrWebClientProvider, type HmrWebClientProviderProps, useHmrWebClient } from './web/react'
export { invokeRpc, rpcErrorMessage } from './web/rpc'
export type {
	ResolvedSseEvents,
	SseClientOptions,
	SseClientWithNamespaces,
	SseMessage,
} from './web/sse'

// Ensure module augmentation for '@pluxel/runtime/web' is included in the TS program.
import './web/plugin-ui-augment'
