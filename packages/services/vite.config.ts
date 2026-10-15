import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks('@pluxel/services', {
			build: 'node ../../scripts/pack.mjs',
			test: 'vp test run',
			typecheck: 'tsc --noEmit --pretty false',
		}),
	},
})
