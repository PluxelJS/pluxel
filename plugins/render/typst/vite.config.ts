import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'node native/build.mjs && pluxel build',
				cache: false,
			},
			'check-tests': {
				command: 'node native/build.mjs && vp test run --config vitest.config.ts',
				dependsOn: ['compile', '@pluxel/test#compile'],
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
