export {
	createRuntimeManagementClient,
	type RuntimeLogClient,
	type RuntimeLogRangeQuery,
	type RuntimeLogStreamsIndex,
	type RuntimeManagementClient,
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
	RuntimeLogAppend,
	RuntimeLogEvent,
	RuntimeLogGap,
	RuntimeLogReset,
	LogStreamMeta,
	RuntimeLogError,
	RuntimeLogLine,
} from './web/logs'
export * from './web/protocol'
export {
	parseConfigFieldPathSegments,
	parseConfigPresentationPlanV1,
	parseRuntimeMeta,
	parseRuntimePortableData,
	RuntimeProtocolValidationError,
} from './web/validation'

export type { RuntimeUpdateSnapshot, RuntimeUpdateError } from './plugin-execution'
