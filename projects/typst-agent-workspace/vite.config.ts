import { defineConfig } from 'vite-plus'
import pack from './tsdown.config.ts'

export default defineConfig({
	pack,
	run: {
		tasks: {
			compile: {
				command: 'pluxel build',
				dependsOn: [
					'@pluxel/plugin-typst#compile',
					'@pluxel/plugin-fonts#compile',
					'@pluxel/host#compile',
				],
				cache: { input: [{ auto: true }], output: ['dist/**'] },
			},
			'check-types': { command: 'tsc --noEmit', dependsOn: ['compile'] },
			'check-tests': {
				command: 'node --test tests/workflow.test.mjs',
				dependsOn: ['compile'],
				cache: false,
			},
		},
	},
})
