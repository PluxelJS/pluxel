import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/plugin-takumi', {
			build: 'pluxel build',
			test: 'vp test run --config vitest.config.ts',
			typecheck: 'tsc --noEmit --pretty false',
		}),
	},
})
