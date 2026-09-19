export { createHost, type HostOptions, type HostApplication, type PluginHost } from './host'
export {
	HostStatePersistenceError,
	PluginGraphRejectedError,
	PluginRestartUnavailableError,
	PluginStartUnavailableError,
	type PluginApplyReport,
} from './coordinator'
export {
	PluginCatalogError,
	type PluginCatalogErrorCode,
	type PluginCatalogSnapshot,
} from './catalog'
export type {
	HostStateSnapshot,
	HostForkState,
	HostProviderDefaultState,
	HostDependencyOverrideState,
} from './policy'
export {
	assertPluginSource,
	PluginSourceRequiredError,
	type PluginSource,
	type PluginSourceRequirement,
	type PluginSourceChange,
	type PluginSourceOpenOptions,
} from './sources'

export {
	defineHostService,
	HostServicePlanError,
	type HostService,
	type HostServiceDependencies,
} from './services'
export {
	ConfigMutationRejectedError,
	type HostPluginConfig,
	type HostPluginConfigResult,
	type HostPluginConfigResultOk,
	type HostPluginConfigResultErr,
} from './config'
export type { HostDocumentStorage, HostStoreStorageOptions } from './document-storage'
export type { HostConfigStoreOptions } from './config-store'
export type { HostStateStoreOptions } from './state-store'

export type {
	HostPluginStatusSnapshot,
	HostPluginStatusOverview,
	HostPluginStatusIssue,
} from './status'
export type { ForkEnsureResult, ForkRemoveResult } from './forks'
export { HostStateMutationRejectedError } from './mutation'

export type { HostOperationOptions } from './coordinator'

export {
	assertHostApplication,
	resolveHostApplication,
	prepareHostApplication,
	type HostStartupContext,
	type ResolvedHostApplication,
} from './application'
export type { HostRuntimeOptions } from './host'

export type {
	PluginApplyReportSnapshot,
	PluginApplyCommitSummary,
	PluginApplyLifecycleIssue,
	PluginApplyLifecycleErrorInfo,
} from './apply-report'
export type { RuntimeUpdateSnapshot } from './execution'
