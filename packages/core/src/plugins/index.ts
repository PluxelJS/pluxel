// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - runtime/: orchestrator and commit scheduling
// - runtime/plugin-service/: PluginService internals and runtime update helpers
// - decorators/: @Plugin/@Config metadata and decorator runtime
// - composition/: BasePlugin + FeatureHost + ConfigHost
// - types.ts: shared plugin type aliases

export * from './composition/BaseFeature'
export * from './composition/ConfigHost'
export * from './composition/cfg'
export * from './composition/FeatureHost'
export * from './composition/PluginHost'
export * from './composition/BasePlugin'
export * from './types'
export * from './decorators/PluginDecorator'
export * from './decorators/decoratorRuntime'
export * from './runtime/fork'
export {
	parseRuntimePluginKey,
	runtimePluginKeyOfIdentity,
	type PluginIdentity,
	type RuntimePluginKey,
} from './runtime/identity'
export * from './runtime/pluginId'
export {
	collectPluginLifecycleBlocked,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	collectPluginLifecycleStoppedWithErrors,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleNotStartedIssue,
	isPluginLifecycleStoppedWithErrorIssue,
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
export type {
	RuntimeModuleDeclaration,
	RuntimeModuleDeclarationItem,
} from './runtime/plugin-service/RuntimeModuleRegistry'
export type {
	CascadeOptions,
	ReplacePluginOptions,
	RuntimeUpdateCommitOptions,
	RuntimeUpdateOptions,
	RuntimeUpdateReason,
	RuntimeUpdateTransaction,
} from './runtime/plugin-service/RuntimeUpdateTransaction'
