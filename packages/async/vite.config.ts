import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/async', {
			build: 'vp pack',
			typecheck: 'tsc --noEmit --pretty false',
			test: 'vp test run && node tests/installed-package.smoke.mjs',
		}),
	},
})
