import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: 'pluxel build',
			'check-tests': 'vp test run',
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
