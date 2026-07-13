import { configsRules } from './rules/configs.ts'
import { importsRules } from './rules/imports.ts'
import { loggingRules } from './rules/logging.ts'
import { pluginsRules } from './rules/plugins.ts'
import type { OxPlugin } from './types.ts'

export const pluxelRules = {
	...loggingRules,
	...configsRules,
	...importsRules,
	...pluginsRules,
}

export type PluxelRuleCategory = 'correctness' | 'logging'
export type PluxelRuleRemediation = 'fix' | 'suggestion' | 'diagnostic'
export type PluxelRuleName = keyof typeof pluxelRules

export const pluxelRulePolicy = {
	'log-no-rendered-error': {
		category: 'logging',
		buildCritical: false,
		remediation: 'diagnostic',
	},
	'log-canonical-error-prop': {
		category: 'logging',
		buildCritical: false,
		remediation: 'fix',
	},
	'configs-use-top-level-class': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'configs-use-no-private-field': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'configs-use-no-early-read': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'configs-use-no-redefault': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'fix',
	},
	'no-direct-logtape-get-logger': {
		category: 'logging',
		buildCritical: false,
		remediation: 'diagnostic',
	},
	'no-workspace-root-import': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'features-use-top-level-class': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'features-load-no-class-field': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'features-load-requires-defined-spec': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'features-load-no-static-load': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'plugin-base-class-requires-plugin-registration': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'plugin-no-process-exit': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'diagnostic',
	},
	'plugin-constructor-no-type-only-imports': {
		category: 'correctness',
		buildCritical: true,
		remediation: 'fix',
	},
} as const satisfies Record<
	keyof typeof pluxelRules,
	{
		category: PluxelRuleCategory
		buildCritical: boolean
		remediation: PluxelRuleRemediation
	}
>

export const pluxelCorrectnessRuleNames = Object.freeze(
	Object.entries(pluxelRulePolicy)
		.filter(([, policy]) => policy.buildCritical)
		.map(([name]) => name as PluxelRuleName),
)

export const pluxelFixableRuleNames = Object.freeze(
	Object.entries(pluxelRulePolicy)
		.filter(([, policy]) => policy.remediation === 'fix')
		.map(([name]) => name as PluxelRuleName),
)

export const pluxelCorrectnessRules = Object.fromEntries(
	pluxelCorrectnessRuleNames.map((name) => [name, pluxelRules[name]]),
) as Pick<typeof pluxelRules, (typeof pluxelCorrectnessRuleNames)[number]>

const pluxelOxlintPlugin: OxPlugin = {
	meta: { name: 'pluxel' },
	rules: pluxelRules,
}

export default pluxelOxlintPlugin
