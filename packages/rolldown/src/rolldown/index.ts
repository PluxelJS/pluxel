export { appendDtsImport } from './plugins/appendDtsImport.ts'
export type { CollectedImportKind, CollectedImportSpecifier } from './plugins/importCollector.ts'
export { collectImportSpecifiers } from './plugins/importCollector.ts'
export type { ConfigSourcePluginOptions } from './plugins/configSourcePlugin.ts'
export { configSourcePlugin } from './plugins/configSourcePlugin.ts'
export type { LintGuardPluginOptions } from './plugins/lintGuardPlugin.ts'
export { lintGuardPlugin } from './plugins/lintGuardPlugin.ts'
export type {
	PluginDefinitionAddressSnapshot,
	PluginDependencyMode,
	PluginEntryAddressSnapshot,
	PluginSemanticDefinition,
	PluginSemanticsPluginOptions,
} from './plugins/pluginSemanticsPlugin.ts'
export { createPluginSemanticsPlugin } from './plugins/pluginSemanticsPlugin.ts'
export type { PluginArtifactBuildPluginOptions } from '../plugin-artifact/pluginArtifactBuildPlugin.ts'
export { pluginArtifactBuildPlugin } from '../plugin-artifact/pluginArtifactBuildPlugin.ts'
export type { Lang } from './plugins/pluginUtils.ts'
export {
	getLangFromId,
	normalizePatterns,
	parseStandaloneWithLang,
	parseWithLang,
} from './plugins/pluginUtils.ts'
export { rewriteDtsText } from './plugins/rewriteDtsText.ts'
export { assertBundleNoText } from './plugins/assertBundleNoText.ts'
