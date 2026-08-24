export type { Context, CoreHostConfig, PluginContext, RootContext } from './context/Context'
export type { ContextLogger } from './logger/LoggerService'

export {
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
	type ContextCapability,
	type ContextCapabilityInstallation,
	type ContextHost,
	type ContextHostOptions,
	type ContextOf,
	type ContextProjection,
	type OwnerViewCapabilityInstallation,
	type RootCapabilityInstallation,
	type RootContextOf,
	type RootContextProjection,
	type ScopeCapabilityInstallation,
} from '@pluxel/context'

export { BasePlugin, OptionalPluginBindings, PluginConfigs, PluginPart } from './plugins'
export type {
	PluginCleanup,
	PluginConstructor,
	PluginContextOf,
	PluginPartClass,
	PluginPartContext,
	PluginPartInfo,
	PluginPartOwner,
	PluginParts,
	PluginToken,
} from './plugins'

export { Plugin, pluginMethodDecorator } from './plugins'
export type { PluginOptions } from './plugins'

export { definePluginRef, pluginDefinitionAddressOf, pluginNodeAddressOf } from './plugins'
export type { PluginRef } from './plugins'

export {
	comparePluginDefinitionAddress,
	comparePluginNodeAddress,
	encodePluginDefinitionAddressBytes,
	encodePluginNodeAddressBytes,
	formatPluginDefinitionReference,
	formatPluginNodeReference,
	formatPluginNodeRoute,
	parsePluginDefinitionAddress,
	parsePluginDefinitionReference,
	parsePluginEntryAddress,
	parsePluginNodeAddress,
	parsePluginNodeReference,
	parsePluginNodeRoute,
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
} from './plugins'
export type {
	ParsedPluginNodeRoute,
	PluginDefinitionAddress,
	PluginDefinitionSlot,
	PluginEntryAddress,
	PluginNodeAddress,
	PluginNodeInfo,
	PluginNodeSlot,
} from './plugins'

export {
	collectPluginLifecycleBlocked,
	collectPluginLifecycleDrainErrors,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleDrainErrorIssue,
	isPluginLifecycleNotStartedIssue,
} from './plugins'
export type {
	CommitSummary,
	PluginCommitChanges,
	PluginLifecycleErrorInfo,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginLifecycleReport,
	PluginReplacement,
	RuntimeUpdateCommitSummary,
} from './plugins'

export { EvtChannel } from './services'
export type { Events, EventsService, EventsServiceConfig, EventsWhenGuard } from './services'
export type { Cleanup, DisposableLike, Effects, EffectsScope } from './services'
