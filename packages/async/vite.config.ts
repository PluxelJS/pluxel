import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: 'vp pack',
			'check-types': 'tsc --noEmit --pretty false',
			'check-tests': {
				command: 'vp test run && node tests/installed-package.smoke.mjs',
				dependsOn: ['@pluxel/async#compile', '@pluxel/test#compile'],
			},
		}),
	},
})
