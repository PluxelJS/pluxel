import { defineConfig, type OxlintConfig } from 'oxlint'
import {
	createPluxelJsPluginEntry,
	pluxelOxlintIgnorePatterns,
	prefixPluxelRuleSet,
	pluxelCorrectnessRules,
} from './packages/workspace/src/oxlint/index.ts'

type RuleMap = NonNullable<OxlintConfig['rules']>
type JsPlugins = NonNullable<OxlintConfig['jsPlugins']>
type IgnorePatterns = NonNullable<OxlintConfig['ignorePatterns']>

const jsPlugins: JsPlugins = [
	createPluxelJsPluginEntry('./packages/workspace/src/oxlint/plugin.ts'),
]

const ignorePatterns: IgnorePatterns = [...pluxelOxlintIgnorePatterns]

export default defineConfig({
	env: { builtin: true },
	jsPlugins,
	ignorePatterns,
	rules: prefixPluxelRuleSet(pluxelCorrectnessRules) as RuleMap,
})
