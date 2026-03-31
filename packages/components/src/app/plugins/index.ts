// Plugins module exports
export { Plugin } from './Plugin'

// List
export { PluginList } from './list'

// Detail
export {
	PluginScreen,
	PluginWorkbench,
	PluginScopeProvider,
	usePluginMeta,
	usePluginStatus,
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
export {
	PluginOverviewProvider,
	getPluginOverviewSnapshot,
	requestPluginOverviewRefetch,
	setPluginOverviewGroups,
	usePluginOverview,
} from './data'
