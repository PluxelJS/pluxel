import lint from './oxlint.config'
import fmt from './oxfmt.config'
import packConfig from './tsdown.config.ts'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	fmt,
	pack: packConfig,
	lint,
	run: {
		tasks: repositoryTasks({
			'check-tests': 'vp test run',
			compile: 'vp pack',
			'check-types': 'tsc --noEmit',
		}),
	},
})
