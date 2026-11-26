import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			'prepare-dev': {
				command: [],
				dependsOn: ['@pluxel/host-vite#compile', 'valibot-form#compile'],
			},
			compile: { command: 'wxt build', cache: { output: ['.output/chrome-mv3/**'] } },
			'check-types': 'wxt prepare && tsc --noEmit',
			'check-tests': { command: 'vp test run', dependsOn: [] },
			'check-smoke': {
				command: 'node scripts/smoke.mjs',
				dependsOn: ['prepare-dev'],
				cache: false,
			},
		}),
	},
})
