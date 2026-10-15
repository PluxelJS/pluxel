import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/wretch', {
			build: 'pluxel build',
			test: 'vp test run',
			typecheck: 'tsc --noEmit --pretty false',
		}),
	},
})
