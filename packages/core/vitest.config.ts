import {
	configSourcePlugin,
	createPluginSemanticsPlugin,
	lintGuardPlugin,
} from '@pluxel/rolldown/plugins'
import { defineConfig } from 'vitest/config'

const pluxelConditions = ['@pluxel/source', 'node', 'import', 'module', 'development', 'default']

export default defineConfig({
	resolve: {
		conditions: pluxelConditions,
	},
	ssr: {
		resolve: {
			conditions: pluxelConditions,
		},
	},
	plugins: [
		createPluginSemanticsPlugin({
			root: import.meta.dirname,
			helperImportSource: '@pluxel/core',
		}).plugin,
		lintGuardPlugin({ cwd: import.meta.dirname }),
		configSourcePlugin({
			metadataHelperImportSource: '@pluxel/core',
			include: [
				'**/src/**/*.ts',
				'**/src/**/*.tsx',
				'**/tests/**/*.ts',
				'**/tests/**/*.tsx',
				'**/fsm/**/*.ts',
				'**/fsm/**/*.tsx',
				'**/parts/**/*.ts',
				'**/parts/**/*.tsx',
			],
			exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		}),
	],
	test: {
		environment: 'node',
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		deps: {
			optimizer: {
				ssr: { enabled: false },
				web: { enabled: false },
			},
		},
	},
})
