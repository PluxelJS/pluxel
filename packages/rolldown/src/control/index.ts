export {
	generatePluginControl,
	type PluginControlGeneration,
	type PluginControlSource,
} from './generate.ts'
export { createPluginControlPlugin, type PluginControlPluginOptions } from './plugin.ts'
export {
	controlSha256,
	encodeControlData,
	isControlExportName,
	isControlFilePath,
	parsePluginControlDescriptor,
	parsePluginControlManifest,
	renderPluginDescriptors,
	verifyPluginControlMaterial,
	verifyPluginControlMaterialSync,
	type PluginControlDescriptorData,
	type PluginControlManifest,
} from './manifest.ts'
