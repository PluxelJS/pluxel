import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { buildTask, checkCache } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: {
			compile: buildTask('vp pack'),
			'check-tests': { command: 'vp test run', dependsOn: ['compile'], cache: checkCache },
			'check-types': { command: 'tsc --noEmit --pretty false', cache: checkCache },
		},
	},
})
