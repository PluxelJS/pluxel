import lint from './oxlint.config'
import packConfig from './tsdown.config.ts'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	lint,
	run: {
		tasks: repositoryTasks('eventure', {
			test: 'vp test run',
			build: 'vp pack',
			typecheck: 'tsc --noEmit',
		}),
	},
})
