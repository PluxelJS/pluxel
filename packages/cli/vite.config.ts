import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/cli', {
			build: 'vp pack && node scripts/copy-development-resources.mjs',
			test: 'vp test run',
			typecheck: 'tsc --noEmit --pretty false --composite false --customConditions development',
		}),
	},
})
