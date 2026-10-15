import type { OxlintConfig } from 'vite-plus/lint'
import { defineConfig } from 'vite-plus'
import {
	createPluxelJsPluginEntry,
	pluxelOxlintIgnorePatterns,
	prefixPluxelRuleSet,
	pluxelCorrectnessRules,
} from './packages/rolldown/src/workspace/oxlint/index.ts'

type RuleMap = NonNullable<OxlintConfig['rules']>
type JsPlugins = NonNullable<OxlintConfig['jsPlugins']>
type IgnorePatterns = NonNullable<OxlintConfig['ignorePatterns']>

const jsPlugins: JsPlugins = [
	createPluxelJsPluginEntry('./packages/rolldown/src/workspace/oxlint/plugin.ts'),
]

const ignorePatterns: IgnorePatterns = [...pluxelOxlintIgnorePatterns]

export default defineConfig({
	lint: {
		env: { builtin: true },
		jsPlugins,
		ignorePatterns,
		rules: prefixPluxelRuleSet(pluxelCorrectnessRules) as RuleMap,
	},
})
