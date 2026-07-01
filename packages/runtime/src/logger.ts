export { ensurePluxelLogging, type EnsurePluxelLoggingOptions } from './logger/ensure'

export {
	createRuntimeLogging,
	type ResolvedConsoleSink,
	type ResolvedFileSink,
	type ResolvedRuntimeLoggingConfig,
	type ResolvedUiSink,
	type RuntimeConsoleSinkInput,
	type RuntimeFileSinkInput,
	type RuntimeLogging,
	type RuntimeLoggingDescription,
	type RuntimeLoggingInput,
	type RuntimeLoggingPreset,
	type RuntimeLoggingSinkId,
	type RuntimeUiSinkInput,
} from './logger/logging'

export {
	createDailyTimeRotatingFileSink,
	getTimeRotatingFileSink,
	type PluxelDailyFileSinkOptions,
	type TimeRotationInterval,
	type TimeRotatingFileSinkOptions,
} from './logger/file'

export { ensureRuntimePluginPolicyLoaded, persistRuntimePluginPolicy } from './logger/levels'

export type {
	CompiledLogFilter,
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
} from './logger/protocol'
export { compileLogFilter, matchesLogFilter, matchesLogFilterCompiled } from './logger/protocol'

export { createRuntimeLogSink, type RuntimeLogSinkOptions } from './logger/sink'

export {
	RuntimePluginLogPolicy,
	parsePluginLogPolicySnapshot,
	runtimePluginLogPolicy,
	serializePluginLogPolicySnapshot,
	type PluginLogPolicySnapshot,
	type RuntimePluginLogLevel,
} from './logger/policy'
export { readPluginLogPolicyFile, writePluginLogPolicyFile } from './logger/policy-file'

export type {
	RuntimeLogStoreAppend,
	RuntimeLogStoreListener,
	RuntimeLogStoreOptions,
	RuntimeLogStoreReset,
} from './logger/store'
export { RuntimeLogStore, runtimeLogs, runtimeLogStores } from './logger/store'
