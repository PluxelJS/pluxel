import './setup'

export { Context } from '@pluxel/core'
export type { CommitSummary } from '@pluxel/core'

export {
	BaseFeature,
	BasePlugin,
	Config,
	defineOptionalFeature,
	FeatureHost,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	checkPluginDecorator,
	clearParamToken,
	getPluginInfo,
	setParamToken,
	setParamTokens,
	UseFeature,
} from '@pluxel/core'

export { EffectsService, EventsService, LoggerService } from '@pluxel/core/services'

export { createContext, createHost, withContext, withHost } from './host'
export type {
	ConfigPatch,
	ConfigPatchByName,
	ConfigPatchFor,
	Host,
	HostConfigHandle,
	TestContext,
} from './host'
