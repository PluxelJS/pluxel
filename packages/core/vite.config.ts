import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			'check-tests': 'vp test run',
			'check-zenfs-browser': { command: 'node tests/zenfs.browser.mjs', cache: false },
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/context#compile', 'eventure#compile'],
				cache: {
					output: ['dist/**'],
				},
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
