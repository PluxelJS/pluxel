export {
	type AdminAccessAwareFetchOptions,
	type AdminAccessBlockedInfo,
	type RuntimeFetch,
	createAdminAccessAwareFetch,
	defaultOnAdminAccessBlocked,
	type OnAdminAccessBlocked,
} from './web/admin-access'
export {
	resolveAdminAccessLandingPath,
	type AdminAccessBlockedCode,
	type AdminAccessBlockedKind,
	type AdminAccessBlockedPayload,
	type AdminAccessReason,
} from './shared/admin-access-http'

export {
	createRuntimeTransportClient,
	createRuntimeTransportFetch,
	createRuntimeTransportLinks,
	expectData,
	type RuntimeLogRangeQuery,
	type RuntimeLogStreamsIndex,
	type RuntimeMeta,
	type RuntimeTransportClient,
	type RuntimeTransportClientOptions,
} from './web/client'
export {
	createRuntimeSecurityClient,
	type AdminAccessOverview,
	type SecurityAuditEvent,
	type SecurityOverview,
	type RuntimeSecurityClient,
	type RuntimeSecurityClientOptions,
	type VaultAdminState,
} from './web/security'
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
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_LOG_STREAMS_BASE,
	RUNTIME_META_BASE,
	RUNTIME_META_INFO_PATH,
	RUNTIME_SECURITY_BASE,
	RUNTIME_SECURITY_EVENTS_PATH,
	RUNTIME_SECURITY_VAULT_DEPLOY_GENERATE_PATH,
	RUNTIME_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH,
	RUNTIME_SECURITY_VAULT_HOST_KEY_PATH,
	RUNTIME_SECURITY_VAULT_UNLOCK_PATH,
	RUNTIME_META_SSE_PATH,
	RUNTIME_TRANSPORT_PATHS,
	RUNTIME_ADMIN_ACCESS_BASE,
	runtimeLogStreamPath,
	runtimeWorkbenchModelEventsPath,
	runtimeWorkbenchLiveQueryPath,
	joinPath,
} from './web/paths'
export * from './web/host-ui'
export * from './web/protocol'
export {
	RuntimeTransportClientProvider,
	type RuntimeTransportClientProviderProps,
	useRuntimeTransportClient,
} from './web/react'
export { invokeRpc, rpcErrorMessage } from './web/rpc'
export type {
	ResolvedSseEvents,
	SseClientOptions,
	SseClientWithNamespaces,
	SseMessage,
} from './web/sse'
