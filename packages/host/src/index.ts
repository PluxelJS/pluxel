import type { PortableApplication } from './application'
import { startEmbeddedApplication, type HostInputs } from './embedded-application'
import { snapshotCoreFacilitiesConfig } from '@pluxel/core/host'
import { createHostFromOptions, type HostOptions, type PluginHost } from './host'

/** Prepare a Node Host with ZenFS. Plugin generations start through host.start(). */
export function createHost(options: HostOptions): Promise<PluginHost> {
	return createHostFromOptions(options, snapshotCoreFacilitiesConfig)
}

/** Start and accept an isolated root from reusable declarations. The caller owns its lifetime. */
export function startHost(
	application: PortableApplication,
	input?: HostInputs<HostOptions['coreConfig']>,
): Promise<PluginHost> {
	return startEmbeddedApplication(application, snapshotCoreFacilitiesConfig, input)
}

export type { HostOptions, HostApplication, PluginHost } from './host'
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
	HostPolicyPatch,
	HostPolicyResetTarget,
	HostGlobalPolicyField,
	HostNodePolicyTarget,
	HostNodePolicyMode,
	HostAutoStartChoice,
	HostForkChoice,
	HostDependencyOverrideChoice,
	HostPolicyValues,
	HostPolicyField,
	HostPolicyModes,
	HostExecutionPolicy,
	HostExecutionPolicyField,
} from './policy'
export type { HostInputMode } from './input-mode'
export type { HostPersistenceResult, HostPersistenceRetention } from './persistence'
export type { HostConfigOptions, ConfigInputPatch } from './config-records'
export type {
	HostPluginDeclaration,
	HostPluginNodesDeclaration,
	HostPluginNodeOptions,
} from './node-declarations'
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
export type { HostDocumentStorage, HostDocumentOptions } from './document-storage'
export type { HostConfigSource } from './config-store'
export type { HostStateConfigurationSnapshot, HostNodePolicySelection } from './state-store'
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
} from './node-application'
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
