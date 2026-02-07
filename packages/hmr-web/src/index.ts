export {
	type AuthAwareFetchOptions,
	type AuthBlockedInfo,
	createAuthAwareFetch,
	defaultOnAuthBlocked,
	type OnAuthBlocked,
} from './auth'

export {
	createHmrWebClient,
	type HmrWebClient,
	type HmrWebClientOptions,
} from './client'
export {
	HmrWebClientProvider,
	type HmrWebClientProviderProps,
	useHmrWebClient,
} from './react'
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
} from './logs'
// Plugin UI authoring + shared helpers
export * from './plugin-ui'
export * from './protocol'

export { invokeRpc, rpcErrorMessage } from './rpc'
export type {
	ResolvedSseEvents,
	SseClientOptions,
	SseClientWithNamespaces,
	SseMessage,
} from './sse'

// Ensure ctx.services.hmr is typed when @pluxel/hmr-web is in the TS program.
import './plugin-ui-augment'
