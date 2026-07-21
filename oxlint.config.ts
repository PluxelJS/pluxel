import { defineConfig, type OxlintConfig, type OxlintOverride } from 'oxlint'
import {
	createPluxelSourceJsPluginEntry,
	pluxelOxlintIgnorePatterns,
	prefixPluxelRuleSet,
	pluxelRules,
} from './packages/rolldown/src/workspace/oxlint/index.ts'

/**
 * Lint design goals for this repo:
 * - Prefer broad, repo-level rules over glob/file carve-outs.
 * - Only keep rules that have clear correctness, async-control-flow, or runtime-safety value.
 * - If a rule conflicts with established architecture, prefer disabling it globally instead of
 *   proliferating per-file exceptions.
 * - Overrides are reserved for real framework/runtime boundaries, not for papering over ordinary code.
 * - Backend/runtime code quality has higher priority than style-only wins.
 *
 * Editing guidance for humans/LLMs:
 * - Do not add a new rule by default unless you have scanned the repo and fixed real violations.
 * - Do not introduce file-level overrides here.
 * - When a rule is noisy, either tighten its scope at directory level for a true subdomain, or turn it off.
 * - Keep the config readable: policy comments matter as much as the rule list.
 */

type Env = NonNullable<OxlintConfig['env']>
type RuleMap = NonNullable<OxlintConfig['rules']>
type Categories = NonNullable<OxlintConfig['categories']>
type Plugins = NonNullable<OxlintConfig['plugins']>
type JsPlugins = NonNullable<OxlintConfig['jsPlugins']>
type IgnorePatterns = NonNullable<OxlintConfig['ignorePatterns']>
type GlobSet = NonNullable<OxlintOverride['files']>

const reactHooksGlobs: GlobSet = [
	'packages/components/src/**/*.{ts,tsx}',
	'packages/valibot-form/src/web/**/*.{ts,tsx}',
]

const macroImportExceptionGlobs: GlobSet = ['packages/core/src/plugins/runtime/**/*.{ts,tsx,mjs}']

const env: Env = {
	builtin: true,
}

const plugins: Plugins = [
	'typescript',
	'unicorn',
	'oxc',
	'import',
	'promise',
	'react',
	'jsx-a11y',
	'vitest',
]
const jsPlugins: JsPlugins = [createPluxelSourceJsPluginEntry()]

const categories: Categories = {
	correctness: 'error',
	suspicious: 'error',
	perf: 'error',
}

const ignorePatterns: IgnorePatterns = [...pluxelOxlintIgnorePatterns]

const createOverride = (files: GlobSet, rules: RuleMap): OxlintOverride => ({ files, rules })
// Repository deviations from enabled defaults. Rules should appear here only when
// Pluxel intentionally differs from oxlint/plugin recommendations.
const baselineRules: RuleMap = {
	'eslint/no-await-in-loop': 'off',
	// Pluxel intentionally uses underscore names for runtime globals, Node compatibility
	// shims, decorator/DI fields, and double-underscore internal hooks.
	'eslint/no-underscore-dangle': 'off',
	'eslint/no-unmodified-loop-condition': 'off',
	'eslint/no-unused-expressions': 'off',
	'eslint/no-unused-vars': 'warn',
	'import/no-unassigned-import': 'off',
	'import/no-cycle': 'error',
	// This repo uses Vitest. Keep overlapping Jest assertion/title rules disabled so test
	// diagnostics come from the Vitest plugin defaults instead of two near-identical rule sets.
	'jest/expect-expect': 'off',
	'jest/no-conditional-expect': 'off',
	'jest/no-standalone-expect': 'off',
	'jest/require-to-throw-message': 'off',
	'jest/valid-expect': 'off',
	'jest/valid-title': 'off',
	// Modal focus is deliberate. The organizer and dependency editors focus their only primary input.
	'jsx-a11y/no-autofocus': 'off',
	// DnD grouping/list roles do not map cleanly to fieldset/ul without changing layout semantics.
	'jsx-a11y/prefer-tag-over-role': 'off',
	'react/exhaustive-deps': 'off',
	'react/no-array-index-key': 'off',
	'react/no-danger': 'error',
	'react/no-unstable-nested-components': 'off',
	'react/react-in-jsx-scope': 'off',
	'react/rules-of-hooks': 'off',
	'typescript/no-extraneous-class': 'off',
	'unicorn/consistent-function-scoping': 'off',
	'unicorn/no-array-sort': 'off',
	'unicorn/prefer-add-event-listener': 'off',
	'unicorn/require-module-specifiers': 'off',
	'vitest/no-standalone-expect': 'off',
	'vitest/require-mock-type-parameters': 'off',
}

// Non-default extra rules that survived repository-wide scans and targeted fixes.
// The acceptance bar is intentionally pragmatic: low noise, stable gain, broad applicability.
const highSignalRules: RuleMap = {
	'eslint/no-duplicate-imports': 'error',
	'eslint/prefer-object-has-own': 'error',
	'react/button-has-type': 'error',
	'react/checked-requires-onchange-or-readonly': 'error',
	'react/forward-ref-uses-ref': 'error',
	'react/iframe-missing-sandbox': 'error',
	'react/jsx-no-constructed-context-values': 'error',
	'react/jsx-no-script-url': 'error',
	'react/jsx-no-target-blank': 'error',
	'react/no-danger-with-children': 'error',
	'react/no-object-type-as-default-prop': 'error',
	'react/no-unknown-property': 'error',
	'react/style-prop-object': 'error',
	'react/void-dom-elements-no-children': 'error',
	'unicorn/error-message': 'error',
	'unicorn/explicit-length-check': 'error',
	'unicorn/no-await-expression-member': 'error',
	'unicorn/no-document-cookie': 'error',
	'unicorn/no-immediate-mutation': 'error',
	'unicorn/no-instanceof-array': 'error',
	'unicorn/no-new-buffer': 'error',
	'unicorn/no-useless-collection-argument': 'error',
	'unicorn/prefer-array-some': 'error',
	'unicorn/prefer-includes': 'error',
	'unicorn/prefer-node-protocol': 'error',
	'unicorn/prefer-optional-catch-binding': 'error',
	'unicorn/prefer-reflect-apply': 'error',
	'unicorn/prefer-string-replace-all': 'error',
	'unicorn/prefer-type-error': 'error',
	'unicorn/throw-new-error': 'error',
}

const rules: RuleMap = {
	...baselineRules,
	...(prefixPluxelRuleSet(pluxelRules) as RuleMap),
	...highSignalRules,
}

// Keep overrides rare and structural.
const overrides: OxlintOverride[] = [
	createOverride(
		// Macro imports need duplicate specifiers with attributes; keep this directory exempt.
		macroImportExceptionGlobs,
		{
			'eslint/no-duplicate-imports': 'off',
		},
	),
	createOverride(
		// Hooks enforcement stays scoped to real React hook-heavy surfaces.
		reactHooksGlobs,
		{
			'react/exhaustive-deps': 'error',
			'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
			'react/rules-of-hooks': 'error',
		},
	),
]

export default defineConfig({
	env,
	plugins,
	jsPlugins,
	categories,
	ignorePatterns,
	rules,
	overrides,
})
