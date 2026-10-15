import { defineConfig } from 'vite-plus'
import { buildTask, checkCache } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: {
			compile: buildTask('pluxel build'),
			'check-tests': { command: 'vp test run', dependsOn: ['compile'], cache: checkCache },
			'check-types': { command: 'tsc --noEmit --pretty false', cache: checkCache },
		},
	},
})
