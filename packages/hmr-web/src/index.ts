export * from './protocol'

export {
	createHmrWebClient,
	type HmrWebClient,
	type HmrWebClientOptions,
} from './client'

export {
	createAuthAwareFetch,
	defaultOnAuthBlocked,
	type AuthAwareFetchOptions,
	type AuthBlockedInfo,
	type OnAuthBlocked,
} from './auth'

export type {
	ResolvedSseEvents,
	SseClientOptions,
	SseClientWithNamespaces,
	SseMessage,
	LogFilter,
	LogRecord,
} from './sse'

export { invokeRpc, rpcErrorMessage } from './rpc'

// Plugin UI authoring + shared helpers
export * from './plugin-ui'

// Ensure ctx.services.hmr is typed when @pluxel/hmr-web is in the TS program.
import './plugin-ui-augment'
