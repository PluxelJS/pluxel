export { appendDtsImport } from './plugins/appendDtsImport'
export type { ConfigSourcePluginOptions } from './plugins/configSourcePlugin'
export { configSourcePlugin, configSourceVitePlugin } from './plugins/configSourcePlugin'
export type {
	ImportTracker,
	ImportTrackerPluginOptions,
	TrackedPluginUsage,
} from './plugins/importTrackerPlugin'
export { createImportTracker } from './plugins/importTrackerPlugin'
export type { ImportTypeFixerPluginOptions } from './plugins/importTypeFixerPlugin'
export { importTypeFixerPlugin, importTypeFixerVitePlugin } from './plugins/importTypeFixerPlugin'
export { rewriteDtsModuleAugmentations } from './plugins/rewriteDtsModuleAugmentations'
