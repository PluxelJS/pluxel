import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'vp pack',
				dependsOn: [
					'@pluxel/rolldown#compile',
					'@pluxel/services#compile',
					'@pluxel/workbench#compile',
				],
				cache: {
					output: ['dist/**'],
				},
			},
			'check-tests': 'vp test run --config vitest.config.ts',
			'check-types': 'tsc -p tsconfig.json --noEmit',
		}),
	},
})
