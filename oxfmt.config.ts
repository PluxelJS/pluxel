import type { OxfmtConfig } from 'vite-plus/fmt'

export default {
	useTabs: true,
	tabWidth: 2,
	printWidth: 100,
	singleQuote: true,
	jsxSingleQuote: false,
	quoteProps: 'as-needed',
	trailingComma: 'all',
	semi: false,
	arrowParens: 'always',
	bracketSameLine: false,
	bracketSpacing: true,
	ignorePatterns: [
		'dist/',
		'**/dist/',
		'coverage/',
		'vendor/',
		'**/*.hbs',
		'packages/core/benchmarks/',
		'packages/workbench/shell/src/app/router/routeTree.gen.ts',
		'projects/plugin-host/pluxel.loader.hmr.discovered.jsonc',
		'projects/docs/next-env.d.ts',
	],
} satisfies OxfmtConfig
