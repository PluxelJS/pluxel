import { defineConfig, type OxlintConfig, type OxlintOverride } from 'oxlint'

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

const plugins: Plugins = ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'react', 'vitest']

const categories: Categories = {
	correctness: 'error',
	suspicious: 'error',
	perf: 'error',
}

const ignorePatterns: IgnorePatterns = [
	'**/dist/**',
	'packages/**/__fixtures__/**',
	'packages/**/tests/fixtures/**',
	'packages/**/__tests__/fixtures/**',
	'packages/components/src/app/router/routeTree.gen.ts',
	'packages/plugins/host/pluxel.hmr.discovered.jsonc',
]

const createOverride = (files: GlobSet, rules: RuleMap): OxlintOverride => ({ files, rules })

// Baseline repo policy: the default stance for rules we explicitly keep on/off.
const baselineRules: RuleMap = {
	'eslint/no-await-in-loop': 'off',
	'eslint/no-control-regex': 'error',
	'eslint/no-unmodified-loop-condition': 'off',
	'eslint/no-unused-expressions': 'off',
	'eslint/no-unused-vars': 'warn',
	'import/no-default-export': 'off',
	'import/no-unassigned-import': 'off',
	'import/no-cycle': 'error',
	'jest/expect-expect': 'off',
	'jest/no-conditional-expect': 'off',
	'jest/no-standalone-expect': 'off',
	'jest/require-to-throw-message': 'off',
	'jest/valid-expect': 'off',
	'jest/valid-title': 'off',
	'promise/always-return': 'error',
	'promise/no-callback-in-promise': 'error',
	'promise/no-multiple-resolved': 'error',
	'react/exhaustive-deps': 'off',
	'react/no-array-index-key': 'off',
	'react/no-danger': 'error',
	'react/no-danger-with-children': 'error',
	'react/react-in-jsx-scope': 'off',
	'react/rules-of-hooks': 'off',
	'typescript/no-empty-interface': 'off',
	'typescript/no-explicit-any': 'off',
	'typescript/no-extraneous-class': 'off',
	'typescript/no-non-null-assertion': 'off',
	'unicorn/consistent-function-scoping': 'off',
	'unicorn/no-array-sort': 'off',
	'unicorn/prefer-add-event-listener': 'off',
	'unicorn/require-module-specifiers': 'off',
	'vitest/require-mock-type-parameters': 'off',
}

// Extra rules that survived repository-wide scans and targeted fixes.
// The acceptance bar is intentionally pragmatic: low noise, stable gain, broad applicability.
const highSignalRules: RuleMap = {
	'eslint/no-duplicate-imports': 'error',
	'eslint/no-useless-concat': 'error',
	'eslint/prefer-object-has-own': 'error',
	'unicorn/error-message': 'error',
	'unicorn/explicit-length-check': 'error',
	'unicorn/no-await-expression-member': 'error',
	'unicorn/no-document-cookie': 'error',
	'unicorn/no-immediate-mutation': 'error',
	'unicorn/no-instanceof-array': 'error',
	'unicorn/no-new-buffer': 'error',
	'unicorn/no-single-promise-in-promise-methods': 'error',
	'unicorn/no-useless-collection-argument': 'error',
	'unicorn/no-thenable': 'error',
	'unicorn/prefer-array-flat-map': 'error',
	'unicorn/prefer-array-some': 'error',
	'unicorn/prefer-includes': 'error',
	'unicorn/prefer-node-protocol': 'error',
	'unicorn/prefer-optional-catch-binding': 'error',
	'unicorn/prefer-reflect-apply': 'error',
	'unicorn/prefer-set-size': 'error',
	'unicorn/prefer-string-replace-all': 'error',
	'unicorn/prefer-type-error': 'error',
	'unicorn/throw-new-error': 'error',
}

const rules: RuleMap = {
	...baselineRules,
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
			'react/rules-of-hooks': 'error',
		},
	),
]

export default defineConfig({
	env,
	plugins,
	categories,
	ignorePatterns,
	rules,
	overrides,
})
