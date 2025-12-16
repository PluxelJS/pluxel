// Plugins module exports
export { Plugin } from './Plugin'

// List
export { PluginsLayout, PluginList } from './list'

// Detail
export {
	PluginScreen,
	PluginLayout,
	PluginScopeProvider,
	usePluginMeta,
	usePluginScope,
} from './detail'
export type { PluginSourceKind, PluginSourceInfo } from './detail'

// Organizer
export {
	PluginOrganizer,
	type GroupConfig,
	type PluginStatus,
	type PluginStatuses,
} from './organizer'

// Config
export { ConfigForm, type ConfigFormProps } from './config'

// Events
export { emitPluginStatusEvent, subscribePluginStatusEvents } from './statusEvents'
