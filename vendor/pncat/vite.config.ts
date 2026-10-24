import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			'check-types': 'tsc --noEmit',
			'check-tests': 'vp test run',
		}),
	},
})
