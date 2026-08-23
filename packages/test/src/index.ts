import './setup'

export type {
	CommitSummary,
	Context,
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
	Plugin,
	PluginPart,
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
