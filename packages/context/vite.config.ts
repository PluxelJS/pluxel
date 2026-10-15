import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/context', {
			test: 'vp test run',
			build: 'vp pack',
			typecheck: 'tsc --noEmit --pretty false',
		}),
	},
})
