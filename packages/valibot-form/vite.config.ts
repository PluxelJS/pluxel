import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('valibot-form', {
			build: 'vp pack',
			test: 'vp test run',
			typecheck: 'tsc -p tsconfig.vitest.json --pretty false',
		}),
	},
})
