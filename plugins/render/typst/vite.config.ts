import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			// Type-only consumers and public package builds need JavaScript and declarations.
			'compile-lib': 'pluxel build',
			compile: {
				command: 'node native/build.mjs',
				dependsOn: ['compile-lib'],
				cache: false,
			},
			'check-tests': {
				command: 'vp test run --config vitest.config.ts',
				dependsOn: ['compile', '@pluxel/test#compile'],
			},
			'check-wasm': {
				command: 'vp test run --config vitest.config.ts tests/wasm.test.ts',
				dependsOn: ['@pluxel/test#compile'],
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
