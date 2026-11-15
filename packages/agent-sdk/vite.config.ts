import { defineConfig } from 'vite-plus'
import pack from './tsdown.config'
import { repositoryTasks } from '../../scripts/vite-tasks'
export default defineConfig({
	pack,
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/host#compile', '@pluxel/rolldown#compile'],
				cache: { output: ['dist/**'] },
			},
			'check-types': 'tsc --noEmit --pretty false',
			'check-tests': { command: 'vp test run', dependsOn: ['compile'] },
		}),
	},
})
