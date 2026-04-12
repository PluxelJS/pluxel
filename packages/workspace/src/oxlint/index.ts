export const PLUXEL_OXLINT_PLUGIN_NAME = 'pluxel'
export const PLUXEL_OXLINT_PACKAGE_SPECIFIER = '@pluxel/workspace/oxlint'
export const PLUXEL_OXLINT_SOURCE_PLUGIN_SPECIFIER = './packages/workspace/src/oxlint/plugin.ts'

export function createPluxelJsPluginEntry(specifier = PLUXEL_OXLINT_PACKAGE_SPECIFIER) {
	return {
		name: PLUXEL_OXLINT_PLUGIN_NAME,
		specifier,
	}
}

export function createPluxelSourceJsPluginEntry(
	specifier = PLUXEL_OXLINT_SOURCE_PLUGIN_SPECIFIER,
) {
	return createPluxelJsPluginEntry(specifier)
}

export function prefixPluxelRuleSet<TLevel extends 'off' | 'warn' | 'error'>(
	rules: Record<string, unknown>,
	level: TLevel = 'error' as TLevel,
) {
	return Object.fromEntries(
		Object.keys(rules).map((name) => [`${PLUXEL_OXLINT_PLUGIN_NAME}/${name}`, level]),
	) as Record<string, TLevel>
}

export {
	default,
	pluxelCorrectnessRuleNames,
	pluxelCorrectnessRules,
	pluxelFixableRuleNames,
	pluxelRulePolicy,
	pluxelRules,
} from './plugin.ts'
export { configsRules } from './rules/configs.ts'
export { augmentationsRules } from './rules/augmentations.ts'
export { pluxelOxlintIgnorePatterns } from './config.ts'
export { importsRules } from './rules/imports.ts'
export { loggingRules } from './rules/logging.ts'
export { pluginsRules } from './rules/plugins.ts'
export type {
	OxDiagnostic,
	OxNode,
	OxPlugin,
	OxRule,
	OxRuleContext,
	OxRuleMeta,
	OxVisitor,
} from './types.ts'
export type { PluxelRuleCategory, PluxelRuleName, PluxelRuleRemediation } from './plugin.ts'
