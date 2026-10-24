import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			'check-tests': 'vp test run',
			compile: 'vp pack',
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
