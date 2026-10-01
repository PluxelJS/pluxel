import { defineConfig, type DummyRuleMap, type RuleCategories } from 'oxlint'

const ignorePatterns = [
	'node_modules/**',
	'dist/**',
	'coverage/**',
	'tinybench/**',
	'**/*.test.ts',
]

const categories = {
	// Keep the default bug-finding rules hard-failing.
	correctness: 'error',
	// Suspicious includes a few useful promise/import rules, but keep it warning
	// level so new upstream heuristics do not suddenly break local development.
	suspicious: 'warn',
	// This package is a tiny event emitter; performance regressions are release
	// blockers, so perf hints are intentionally errors.
	perf: 'error',
} satisfies RuleCategories

const typeSafetyRules = {
	'@typescript-eslint/array-type': ['error', { default: 'array' }],
	'@typescript-eslint/consistent-type-exports': 'error',
	'@typescript-eslint/consistent-type-imports': 'error',
	'@typescript-eslint/no-import-type-side-effects': 'error',
	'@typescript-eslint/no-invalid-void-type': 'error',
	'@typescript-eslint/no-misused-promises': 'warn',
	'@typescript-eslint/no-unsafe-function-type': 'error',
	'@typescript-eslint/non-nullable-type-assertion-style': 'error',
	'@typescript-eslint/only-throw-error': 'error',
	'@typescript-eslint/prefer-includes': 'error',
	'@typescript-eslint/prefer-nullish-coalescing': 'error',
	'@typescript-eslint/prefer-promise-reject-errors': 'error',
	'@typescript-eslint/restrict-plus-operands': 'error',
	'@typescript-eslint/return-await': 'error',
	'@typescript-eslint/strict-boolean-expressions': 'error',
	'@typescript-eslint/switch-exhaustiveness-check': 'error',
	'@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
} satisfies DummyRuleMap

const importRules = {
	'import/first': 'error',
	'import/no-absolute-path': 'error',
	'import/no-cycle': 'error',
	'import/no-default-export': 'error',
	'import/no-duplicates': 'error',
	'import/no-named-default': 'error',
	'import/no-self-import': 'error',
	'node/no-new-require': 'error',
	'node/no-path-concat': 'error',
} satisfies DummyRuleMap

const runtimeRules = {
	'accessor-pairs': 'error',
	'array-callback-return': 'error',
	'default-case-last': 'error',
	'default-param-last': 'error',
	eqeqeq: ['error', 'always', { null: 'ignore' }],
	'guard-for-in': 'error',
	'no-case-declarations': 'error',
	'no-constructor-return': 'error',
	'no-eq-null': 'error',
	'no-fallthrough': 'error',
	'no-loop-func': 'error',
	'no-new-func': 'error',
	'no-promise-executor-return': 'error',
	'no-redeclare': 'error',
	'no-return-assign': 'error',
	'no-script-url': 'error',
	'no-self-compare': 'error',
	'no-template-curly-in-string': 'error',
	'no-throw-literal': 'error',
	'no-useless-assignment': 'error',
	'no-useless-computed-key': 'error',
	'no-useless-return': 'error',
	'no-var': 'error',
	radix: 'error',
	'symbol-description': 'error',
} satisfies DummyRuleMap

const consistencyRules = {
	'no-implicit-coercion': 'error',
	'object-shorthand': 'error',
	'operator-assignment': 'error',
	'prefer-const': 'error',
	'prefer-exponentiation-operator': 'error',
	'prefer-numeric-literals': 'error',
	'prefer-object-has-own': 'error',
	'prefer-object-spread': 'error',
	'prefer-template': 'error',
	yoda: 'error',
} satisfies DummyRuleMap

const unicornRules = {
	'unicorn/no-negation-in-equality-check': 'error',
	'unicorn/no-typeof-undefined': 'error',
	'unicorn/no-useless-promise-resolve-reject': 'error',
	'unicorn/no-useless-undefined': 'error',
	'unicorn/prefer-date-now': 'error',
	'unicorn/prefer-math-min-max': 'error',
	'unicorn/prefer-math-trunc': 'error',
	'unicorn/prefer-node-protocol': 'error',
	'unicorn/prefer-number-properties': 'error',
	'unicorn/prefer-type-error': 'error',
	'unicorn/throw-new-error': 'error',
} satisfies DummyRuleMap

// These are deliberate tradeoffs for Eventure's API shape and hot paths.
const projectTradeoffRules = {
	// Event descriptors and listener wrappers are intentionally variadic.
	'@typescript-eslint/no-explicit-any': 'off',
	// The hot arrays are indexed after length checks; `!` avoids slower helpers
	// under `noUncheckedIndexedAccess`.
	'@typescript-eslint/no-non-null-assertion': 'off',
	// Symbol metadata and wrapped listener identity require type assertions.
	'@typescript-eslint/no-unsafe-type-assertion': 'off',
	// Generic event listeners can be sync, promise-like, or async-generator
	// adjacent; runtime detection is handled explicitly in `utils.ts`.
	'@typescript-eslint/await-thenable': 'off',
	// Good rule in many apps, but it currently false-positives on closure mutation
	// in the allocation-sensitive waterfall dispatcher.
	'@typescript-eslint/no-unnecessary-condition': 'off',
	// Cancellable promises attach `.cancel`; making factories `async` would wrap
	// and lose the custom property.
	'@typescript-eslint/promise-function-async': 'off',
	// We intentionally use `void somePromise` to mark fire-and-forget cleanup.
	'no-void': 'off',
	// Empty no-op callbacks are part of the unsubscribe/logger APIs.
	'no-empty-function': 'off',
	// We sort copied arrays in Node-only reporting scripts; requiring ES2023
	// `toSorted` would raise the runtime floor for no practical benefit.
	'unicorn/no-array-sort': 'off',
	// Pre-sized arrays are used in hot paths; `new Array(len)` avoids the
	// callback/object overhead of `Array.from({ length })`.
	'unicorn/no-new-array': 'off',
	// `arguments`/`.apply` are used in waterfall to avoid rest/spread allocation
	// on small arities.
	'prefer-rest-params': 'off',
	'prefer-spread': 'off',
	'unicorn/prefer-spread': 'off',
} satisfies DummyRuleMap

export default defineConfig({
	plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'node'],
	categories,
	ignorePatterns,
	env: {
		builtin: true,
		node: true,
	},
	options: {
		reportUnusedDisableDirectives: 'error',
		typeAware: true,
	},
	rules: {
		...typeSafetyRules,
		...importRules,
		...runtimeRules,
		...consistencyRules,
		...unicornRules,
		...projectTradeoffRules,
	},
	overrides: [
		{
			files: ['src/types.ts', 'src/ext/limitSingle.ts'],
			rules: {
				// Public listener/guard types intentionally accept void callbacks.
				'@typescript-eslint/no-invalid-void-type': 'off',
			},
		},
		{
			files: ['src/ext/fireShared.ts'],
			rules: {
				// Async generators must preserve listener order and stop semantics.
				'no-await-in-loop': 'off',
			},
		},
		{
			files: ['oxlint.config.ts', 'tsdown.config.ts', 'vitest.config.ts'],
			rules: {
				// Tooling config files are consumed through default exports.
				'import/no-default-export': 'off',
			},
		},
	],
})
