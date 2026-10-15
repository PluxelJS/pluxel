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
			'governance:check': {
				command: 'pluxel workspace doctor && node scripts/check-workspace-governance.mjs',
				cache: false,
			},
			check: { command: 'vp check', cache: false },
			build: { command: [], dependsOn: ['@example/host#compile'] },
			test: {
				command: [],
				dependsOn: [
					'@example/domain#check-tests',
					'@example/audit-plugin#check-tests',
					'@example/http-plugin#check-tests',
					'@example/todo-plugin#check-tests',
				],
			},
			verify: {
				command: [],
				cache: false,
				dependsOn: ['governance:check', 'check', 'test', 'build'],
			},
		},
	},
})
