// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - runtime/: orchestrator and commit scheduling
// - decorators/: @Plugin/@Config metadata and decorator runtime
// - composition/: BasePlugin + FeatureHost + ConfigHost
// - types.ts: shared plugin type aliases

export * from './composition/BaseFeature'
export * from './composition/ConfigHost'
export * from './composition/cfg'
export * from './composition/FeatureHost'
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
	type CommitSummary,
	type PluginLifecycleErrorInfo,
	type PluginLifecycleIssue,
	type PluginLifecycleIssueKind,
	type PluginLifecycleIssuePhase,
	type PluginLifecycleIssuePredicate,
	type PluginLifecycleReport,
	type PluginCommitChanges,
	type PluginReplacement,
	PluginService,
	type RuntimeUpdateCommitSummary,
} from './runtime/PluginService'
