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
	createRuntimeManagementClient,
	discoverRuntime,
	type RuntimeLogRangeQuery,
	type RuntimeLogStreamsIndex,
	type RuntimeManagementClient,
	type RuntimeManagementClientOptions,
} from './web/client'
export {
	type AdminAccessOverview,
	type SecurityAuditEvent,
	type SecurityOverview,
	type RuntimeSecurityClient,
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
export * from './web/protocol'
export {
	parseConfigFieldPathSegments,
	parseConfigPresentationPlanV1,
	parseRuntimeMetaV1,
	parseRuntimePortableData,
	RuntimeProtocolValidationError,
} from './web/validation'
export { rpcErrorMessage } from './web/rpc-session'
