import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: 'pluxel build',
			'check-tests': {
				command: 'vp test run --config vitest.config.ts',
				cache: false,
				dependsOn: [
					{
						task: 'compile',
						from: ['dependencies', 'devDependencies', 'peerDependencies'],
					},
					'compile',
					'@pluxel/test#compile',
				],
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
