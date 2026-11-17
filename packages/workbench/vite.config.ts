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
			'check-native': {
				command: 'node ../../scripts/check-worksplit-native.mjs .',
				dependsOn: ['@worksplit/react#compile'],
				cache: false,
			},
			'compile-web': {
				command: 'vp build --config vite.shell.config.ts',
				dependsOn: [
					'check-native',
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
