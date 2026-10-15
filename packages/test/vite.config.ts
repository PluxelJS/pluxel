import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/test', {
			build: 'vp pack',
			test: 'vp test run --config vitest.config.ts',
			typecheck: 'tsc -p tsconfig.json --noEmit',
		}),
	},
})
