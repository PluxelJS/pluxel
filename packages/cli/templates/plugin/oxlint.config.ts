import type { OxlintConfig } from 'vite-plus/lint'
import {
	createPluxelJsPluginEntry,
	pluxelOxlintIgnorePatterns,
	pluxelRules,
	prefixPluxelRuleSet,
} from '@pluxel/rolldown/oxlint'

type RuleMap = NonNullable<OxlintConfig['rules']>

const config: OxlintConfig = {
	env: { builtin: true },
	plugins: ['typescript', 'unicorn', 'import', 'promise', 'react', 'vitest'],
	jsPlugins: [createPluxelJsPluginEntry()],
	categories: {
		correctness: 'error',
		suspicious: 'error',
		perf: 'error',
	},
	ignorePatterns: [...pluxelOxlintIgnorePatterns],
	rules: {
		...(prefixPluxelRuleSet(pluxelRules) as RuleMap),
		'eslint/no-unused-vars': 'warn',
		'import/no-unassigned-import': 'off',
		'react/exhaustive-deps': 'error',
		'react/react-in-jsx-scope': 'off',
		'react/rules-of-hooks': 'error',
	},
}

export default config
