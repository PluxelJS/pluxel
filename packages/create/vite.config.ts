import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/create', {
			build: 'vp pack',
			test: 'vp test run --dir tests',
			typecheck: 'tsc --noEmit --pretty false',
		}),
	},
})
