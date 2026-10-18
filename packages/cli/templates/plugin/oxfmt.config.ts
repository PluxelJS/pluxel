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
	sortPackageJson: false,
	ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/.vite/**'],
} satisfies OxfmtConfig
