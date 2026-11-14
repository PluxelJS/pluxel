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
	type PluginControlMetadata,
	type PluginControlMaterial,
} from './catalog'
export type {
	HostStateSnapshot,
	HostForkState,
	HostProviderDefaultState,
	HostDependencyOverrideState,
	HostPolicyOptions,
	HostPolicyInput,
	HostPolicyValues,
	HostPolicyField,
	HostPolicyModes,
	HostExecutionPolicy,
	HostExecutionPolicyField,
} from './policy'
export type { HostInputMode } from './input-mode'
export type { HostPersistenceResult, HostPersistenceRetention } from './persistence'
export type { HostConfigOptions, HostConfigRecordInput, ConfigInputPatch } from './config-records'
export type { PluginSource } from './sources'

export {
	defineHostService,
	HostServicePlanError,
	type HostService,
	type HostServiceDependencies,
} from './services'
export {
	ConfigMutationRejectedError,
	type HostPluginConfig,
	type HostConfigState,
	type HostConfigMutation,
	type HostConfigInputSnapshot,
	type HostPluginConfigResult,
	type HostPluginConfigResultOk,
	type HostPluginConfigResultErr,
} from './config'
export type {
	HostDocumentStorage,
	HostDocumentOptions,
	HostDocumentFacilities,
} from './document-storage'
export type { HostConfigSource } from './config-store'
export type { HostStateConfigurationSnapshot } from './state-store'
export type { HostPolicy, HostPolicyResult } from './policy-management'

export type {
	HostPluginStatusSnapshot,
	HostPluginStatusOverview,
	HostPluginStatusIssue,
} from './status'
export type { ForkEnsureResult, ForkRemoveResult } from './forks'
export { HostStateMutationRejectedError } from './mutation'

export type { HostOperationOptions } from './coordinator'

export {
	defineHostApplication,
	type HostApplicationFactory,
	runHostApplication,
	resolveHostApplication,
	prepareHostApplication,
	type HostStartupContext,
	type ResolvedHostApplication,
} from './application'
export type { HostRuntimeOptions } from './host'
export { HostApplicationStartupError, type HostApplicationStartup } from './application-start'

export type {
	PluginApplyReportSnapshot,
	PluginApplyCommitSummary,
	PluginApplyLifecycleIssue,
	PluginApplyLifecycleErrorInfo,
} from './apply-report'
export type { RuntimeUpdateSnapshot } from './execution'

export {
	envBinding,
	fileBinding,
	type HostEnvironmentBinding,
	type HostFileBinding,
	type InputMapping,
	type VaultInputMapping,
} from './bindings'

export { InputBindingError } from './input-bindings'
