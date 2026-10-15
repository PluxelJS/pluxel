import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/host', {
			build: 'vp pack',
			typecheck: 'tsc --noEmit --pretty false',
			test: 'vp test run',
		}),
	},
})
