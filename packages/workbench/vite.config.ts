import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'
import packConfig from './tsdown.config'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'node scripts/verify-shell.mjs',
				dependsOn: ['compile-lib'],
				cache: {
					output: [],
				},
			},
			'check-types':
				'tsc --noEmit --pretty false && tsc --noEmit --pretty false -p shell/tsconfig.json',
			'check-tests': 'vp test run && vp test run --config shell/vitest.config.ts',
			'compile-web': {
				command: 'vp build --config vite.shell.config.ts',
				dependsOn: [
					'@pluxel/services#compile',
					'@pluxel/rolldown#compile',
					'@worksplit/react#compile',
					'valibot-form#compile',
				],
			},
			'compile-lib': {
				command: 'vp pack',
				dependsOn: ['compile-web'],
			},
		}),
	},
})
