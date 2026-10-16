import { defineConfig } from 'vite-plus'
import lint from './oxlint.config'

export default defineConfig({
	fmt: {
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
	},
	lint: { ...lint, options: { typeAware: true, typeCheck: true } },
	run: {
		tasks: {
			compile: {
				command: 'pluxel build',
				cache: {
					input: [{ auto: true }, 'mise.toml'],
					env: ['CI', 'NODE_ENV'],
					output: ['dist/**'],
				},
			},
			'check-tests': {
				dependsOn: ['compile'],
				command: 'vp test run',
				cache: {
					input: [{ auto: true }, 'mise.toml'],
					env: ['CI', 'NODE_ENV'],
					output: [],
				},
			},
			'check-types': { command: 'tsc --noEmit --pretty false' },
			'verify:checks': { command: 'vp check', cache: false },
			'governance:check': { command: 'pluxel workspace doctor', cache: false },
			'workspace:verify': {
				command: [],
				cache: false,
				dependsOn: ['governance:check', 'verify:checks', 'check-tests', 'compile'],
			},
		},
	},
})
