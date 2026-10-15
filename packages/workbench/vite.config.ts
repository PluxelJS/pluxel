import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'
import packConfig from './tsdown.config'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks('@pluxel/workbench', {
			build: 'node scripts/verify-shell.mjs',
			typecheck:
				'tsc --noEmit --pretty false && tsc --noEmit --pretty false -p shell/tsconfig.json',
			test: 'vp test run && vp test run --config shell/vitest.config.ts',
			'build:web': 'vp build --config vite.shell.config.ts',
			'build:lib': 'vp pack',
		}),
	},
})
