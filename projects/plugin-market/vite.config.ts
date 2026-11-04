import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'wrangler deploy --dry-run --outdir dist',
				dependsOn: [],
			},
			'check-tests': {
				command: 'vp test run --config vitest.config.ts',
				dependsOn: [],
				cache: false,
			},
			'check-types': { command: 'tsc --noEmit --pretty false', dependsOn: [] },
		}),
	},
})
