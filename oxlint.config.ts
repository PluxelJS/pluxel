import type { OxlintConfig, OxlintOverride } from 'vite-plus/lint'
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
	'packages/workbench/shell/src/**/*.{ts,tsx}',
	'packages/valibot-form/src/web/**/*.{ts,tsx}',
]

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

const ignorePatterns: IgnorePatterns = [
	...pluxelOxlintIgnorePatterns,
	// These independent projects and uninstalled templates have their own checks.
	'vendor/**',
	'engineering/**',
	'packages/create/template/**',
	'packages/cli/templates/**',
]

const createOverride = (files: GlobSet, rules: RuleMap): OxlintOverride => ({ files, rules })
// Repository deviations from enabled defaults. Rules should appear here only when
// Pluxel intentionally differs from oxlint/plugin recommendations.
const baselineRules: RuleMap = {
	// Enabling the TypeScript engine must not broaden the existing lint policy.
	// These category defaults were inactive before typeAware; frontend rules opt in below.
	'typescript/await-thenable': 'off',
	'typescript/consistent-return': 'off',
	'typescript/no-array-delete': 'off',
	'typescript/no-base-to-string': 'off',
	'typescript/no-duplicate-type-constituents': 'off',
	'typescript/no-floating-promises': 'off',
	'typescript/no-for-in-array': 'off',
	'typescript/no-generated-empty-object-type': 'off',
	'typescript/no-implied-eval': 'off',
	'typescript/no-meaningless-void-operator': 'off',
	'typescript/no-misused-spread': 'off',
	'typescript/no-redundant-type-constituents': 'off',
	'typescript/no-unnecessary-boolean-literal-compare': 'off',
	'typescript/no-unnecessary-template-expression': 'off',
	'typescript/no-unnecessary-type-arguments': 'off',
	'typescript/no-unnecessary-type-assertion': 'off',
	'typescript/no-unnecessary-type-conversion': 'off',
	'typescript/no-unnecessary-type-parameters': 'off',
	'typescript/no-unsafe-enum-comparison': 'off',
	'typescript/no-unsafe-type-assertion': 'off',
	'typescript/no-unsafe-unary-minus': 'off',
	'typescript/no-useless-default-assignment': 'off',
	'typescript/require-array-sort-compare': 'off',
	'typescript/restrict-template-expressions': 'off',
	'typescript/unbound-method': 'off',
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
	// oxlint-tsgolint 7 enables React Compiler diagnostics through the broad correctness
	// category. Adopting those rules is a separate UI architecture migration; keep the
	// repository's existing, explicitly selected Hooks and runtime-safety policy stable.
	'react/exhaustive-effect-dependencies': 'off',
	'react/globals': 'off',
	'react/immutability': 'off',
	'react/incompatible-library': 'off',
	'react/memo-dependencies': 'off',
	'react/no-deriving-state-in-effects': 'off',
	'react/no-array-index-key': 'off',
	'react/no-danger': 'error',
	'react/no-unstable-nested-components': 'off',
	'react/preserve-manual-memoization': 'off',
	'react/react-in-jsx-scope': 'off',
	'react/refs': 'off',
	'react/rules-of-hooks': 'off',
	'react/set-state-in-effect': 'off',
	'react/use-memo': 'off',
	'typescript/no-extraneous-class': 'off',
	'unicorn/consistent-function-scoping': 'off',
	'unicorn/no-array-sort': 'off',
	'unicorn/prefer-add-event-listener': 'off',
	'unicorn/require-module-specifiers': 'off',
	// Error-suffixed APIs can be factories (TaggedError); do not rename them to satisfy a name heuristic.
	'unicorn/throw-new-error': 'off',
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
}

const rules: RuleMap = {
	...baselineRules,
	...(prefixPluxelRuleSet(pluxelRules) as RuleMap),
	...highSignalRules,
}

// Keep overrides rare and structural.
const overrides: OxlintOverride[] = [
	createOverride(
		// Hooks enforcement stays scoped to real React hook-heavy surfaces.
		reactHooksGlobs,
		{
			'react/exhaustive-deps': 'error',
			'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
			'react/rules-of-hooks': 'error',
			'typescript/await-thenable': 'error',
			'typescript/no-array-delete': 'error',
			'typescript/no-base-to-string': 'error',
			'typescript/no-floating-promises': 'error',
			'typescript/no-for-in-array': 'error',
			'typescript/no-misused-promises': 'error',
			'typescript/no-misused-spread': 'error',
			'typescript/only-throw-error': 'error',
			'typescript/prefer-promise-reject-errors': 'error',
			'typescript/use-unknown-in-catch-callback-variable': 'error',
		},
	),
]

export default {
	options: { typeAware: true, typeCheck: true, reportUnusedDisableDirectives: 'error' },
	env,
	plugins,
	jsPlugins,
	categories,
	ignorePatterns,
	rules,
	overrides,
} satisfies OxlintConfig
