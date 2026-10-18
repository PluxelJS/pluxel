import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

const tasks = repositoryTasks('@pluxel/cli', {
	build: 'vp pack',
	test: 'vp test run',
	typecheck: 'tsc --noEmit --pretty false --composite false --customConditions development',
})
const compile = tasks.compile!
const compileCache = typeof compile.cache === 'object' ? compile.cache : {}

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: {
			...tasks,
			'compile-code': {
				...compile,
				cache: {
					...compileCache,
					output: ['dist/**', '!dist/resources/**', '!dist/source-fingerprint'],
				},
			},
			compile: {
				command: 'node scripts/copy-development-resources.mjs',
				dependsOn: ['compile-code'],
				cache: { ...compileCache, output: ['dist/resources/**', 'dist/source-fingerprint'] },
			},
		},
	},
})
