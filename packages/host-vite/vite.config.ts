import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			'check-tests': {
				command: 'vp test run',
				dependsOn: [
					{
						task: 'compile',
						from: ['dependencies', 'devDependencies', 'peerDependencies'],
					},
					'compile',
					'@pluxel/host#compile',
					'@pluxel/test#compile',
				],
			},
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/core#compile', '@pluxel/host#compile', '@pluxel/rolldown#compile'],
				cache: {
					output: ['dist/**'],
				},
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
