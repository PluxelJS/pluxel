// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - runtime/: orchestrator and commit scheduling
// - runtime/plugin-service/: PluginService internals and runtime update helpers
// - decorators/: thin @Plugin marker and decorator runtime
// - composition/: BasePlugin + PluginConfigs + OptionalPluginBindings
// - types.ts: shared plugin type aliases

export * from './composition/PluginConfigs'
export * from './composition/OptionalPluginBindings'
export { PluginPart, type PluginPartClass } from './composition/PluginPart'
export * from './composition/BasePlugin'
export * from './types'
export * from './decorators/PluginDecorator'
export * from './decorators/decoratorRuntime'
export {
	definePluginRef,
	isPluginRef,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	type PluginRef,
} from './runtime/definition'
export * from './runtime/identity'
export {
	collectPluginLifecycleBlocked,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	collectPluginLifecycleDrainErrors,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleNotStartedIssue,
	isPluginLifecycleDrainErrorIssue,
	type PluginLifecycleErrorInfo,
	type PluginLifecycleIssue,
	type PluginLifecycleIssueKind,
	type PluginLifecycleIssuePhase,
	type PluginLifecycleIssuePredicate,
	type PluginLifecycleReport,
} from './runtime/plugin-service/LifecycleReport'
export {
	type CommitSummary,
	type PluginCommitChanges,
	type PluginReplacement,
	type RuntimeUpdateCommitSummary,
} from './runtime/plugin-service/CommitPlan'
export { PluginService } from './runtime/PluginService'
export type { PluginNodeInfo } from './runtime/PluginDefinitions'
export type {
	CascadeOptions,
	PreparedRuntimeUpdateCommitOptions,
	PreparedRuntimeUpdate,
	ReplaceDefinitionOptions,
	RuntimeUpdateOptions,
	RuntimeUpdateReason,
	RuntimeUpdateTransaction,
} from './runtime/plugin-service/RuntimeUpdateTransaction'
