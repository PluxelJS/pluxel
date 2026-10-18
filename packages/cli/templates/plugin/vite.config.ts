import { defineConfig } from 'vite-plus'
import lint from './oxlint.config'
import fmt from './oxfmt.config'

export default defineConfig({
	fmt,
	lint: { ...lint, options: { typeAware: true, typeCheck: true } },
	run: {
		tasks: {
			compile: {
				command: 'pluxel build',
				cache: {
					input: [{ auto: true }, 'mise.toml'],
					env: ['CI', 'NODE_ENV'],
					output: ['dist/**'],
				},
			},
			'check-tests': {
				dependsOn: ['compile'],
				command: 'vp test run',
				cache: {
					input: [{ auto: true }, 'mise.toml'],
					env: ['CI', 'NODE_ENV'],
					output: [],
				},
			},
			'check-types': { command: 'tsc --noEmit --pretty false' },
			'verify:checks': { command: 'vp check', cache: false },
			'governance:check': { command: 'pluxel workspace doctor', cache: false },
			'workspace:verify': {
				command: [],
				cache: false,
				dependsOn: ['governance:check', 'verify:checks', 'check-tests', 'compile'],
			},
		},
	},
})
