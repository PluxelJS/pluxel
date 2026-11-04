import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/core#compile'],
				cache: {
					output: ['dist/**'],
				},
			},
			'check-types': 'tsc --noEmit --pretty false',
			'check-tests': {
				command: 'vp test run',
				cache: {
					env: ['PLAYWRIGHT_WS_ENDPOINT', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME'],
				},
			},
		}),
	},
})
