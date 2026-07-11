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
	BaseFeature,
	BasePlugin,
	Config,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	collectPluginLifecycleStoppedWithErrors,
	defineLazyFeature,
	FeatureHost,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	checkPluginDecorator,
	clearParamToken,
	getPluginInfo,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleNotStartedIssue,
	isPluginLifecycleStoppedWithErrorIssue,
	setParamToken,
	setParamTokens,
} from '@pluxel/core'

export { EffectsService, EventsService, LoggerService } from '@pluxel/core/services'

export {
	assertPluginLifecycleIssue,
	findPluginLifecycleIssue,
	pluginLifecycleIssuePlugins,
} from '@pluxel/core/test'
export type { CoreHostLifecycleIssueExpectation } from '@pluxel/core/test'

export { createContext, createHost, withContext, withHost } from './host'
export type {
	ConfigPatch,
	ConfigPatchByName,
	ConfigPatchFor,
	Host,
	HostConfigHandle,
	TestContext,
} from './host'
