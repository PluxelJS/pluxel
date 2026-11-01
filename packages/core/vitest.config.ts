import {
	configSourcePlugin,
	createPluginSemanticsPlugin,
	lintGuardPlugin,
} from '@pluxel/rolldown/plugins'
import { defineConfig } from 'vitest/config'

const pluxelConditions = ['@pluxel/source', 'node', 'development', 'default']
// External modules run in Node; upstream bundler-only ESM exports may omit extensions.
const externalConditions = ['node', 'default']

export default defineConfig({
	resolve: {
		conditions: pluxelConditions,
		externalConditions,
	},
	ssr: {
		resolve: {
			conditions: pluxelConditions,
			externalConditions,
		},
	},
	plugins: [
		createPluginSemanticsPlugin({
			root: import.meta.dirname,
		}).plugin,
		lintGuardPlugin({ cwd: import.meta.dirname }),
		configSourcePlugin({
			include: [
				'**/src/**/*.ts',
				'**/src/**/*.tsx',
				'**/tests/**/*.ts',
				'**/tests/**/*.tsx',
				'**/parts/**/*.ts',
				'**/parts/**/*.tsx',
			],
			exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		}),
	],
	test: {
		environment: 'node',
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
	},
})
