import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/commands', {
			test: 'vp test run',
			typecheck: 'tsc --noEmit --pretty false',
			build: 'vp pack',
		}),
	},
})
