import './setup'

export { Context } from '@pluxel/core'
export type {
	CommitSummary,
	PluginLifecycleErrorInfo,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginLifecycleReport,
	PluginCommitChanges,
	PluginReplacement,
	RuntimeUpdateCommitSummary,
} from '@pluxel/core'

export {
	BasePlugin,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleDrainErrors,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	definePluginRef,
	ForkablePlugin,
	Plugin,
	getPluginInfo,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleDrainErrorIssue,
	isPluginLifecycleNotStartedIssue,
} from '@pluxel/core'

export { LoggerService } from '@pluxel/core/logger'
export { EffectsService } from '@pluxel/core/services'

export {
	assertPluginLifecycleIssue,
	findPluginLifecycleIssue,
	pluginLifecycleIssuePlugins,
} from '@pluxel/core/test'
export type { CoreHostLifecycleIssueExpectation } from '@pluxel/core/test'

export { createContext, createHost, withContext, withHost } from './host'
export type { ConfigPatch, Host, HostConfigHandle, TestContext } from './host'
