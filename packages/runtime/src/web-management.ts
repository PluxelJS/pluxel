export { doc } from './web/extensions'
export {
	ui,
	type PluginUiModuleDeclaration,
	type PluginUiSourceDeclaration,
} from './web-management/ui'
export type {
	SignalDbCollectionHandle as ManagementStateCollection,
	SignalDbCollectionOptions as ManagementStateCollectionOptions,
	SignalDbDocumentHandle as ManagementStateDocument,
} from './services/plugin-interaction/SignalDbService'
export type { SseChannel } from './services/plugin-interaction/SseService'
export type {
	PluginManagementState,
	PluginRpcRegistry,
	PluginSseRegistry,
	PluginUiContributions,
	PluginWebManagement,
} from './services/web-management/WebManagementService'
