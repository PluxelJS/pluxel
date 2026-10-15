import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks('@pluxel-internal/pncat', {
			typecheck: 'tsc --noEmit',
			test: 'vp test run',
		}),
	},
})
