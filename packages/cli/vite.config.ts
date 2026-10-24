import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

const tasks = repositoryTasks({
	compile: {
		command: 'vp pack',
		dependsOn: ['@pluxel/rolldown#compile'],
		cache: {
			input: [
				{
					pattern: 'packages/cli/scripts/sync-template-catalog.*',
					base: 'workspace',
				},
				{
					pattern: 'scripts/repository-packages.mjs',
					base: 'workspace',
				},
				{
					pattern: 'packages/*/package.json',
					base: 'workspace',
				},
				{
					pattern: 'plugins/*/package.json',
					base: 'workspace',
				},
				{
					pattern: 'plugins/*/*/package.json',
					base: 'workspace',
				},
				{
					pattern: 'templates/**',
					base: 'package',
				},
				{
					pattern: '!templates/**/node_modules/**',
					base: 'package',
				},
				{
					pattern: 'docs/**',
					base: 'workspace',
				},
				{
					pattern: '.agents/skills/pluxel-development/**',
					base: 'workspace',
				},
				{
					pattern: 'pnpm-workspace.yaml',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/src/**',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/package.json',
					base: 'workspace',
				},
				{
					pattern: 'tsconfig.cli-build.json',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/LICENSE.md',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/UPSTREAM.md',
					base: 'workspace',
				},
			],
			output: ['dist/**'],
		},
	},
	'check-tests': {
		command: 'vp test run',
		dependsOn: [
			{
				task: 'compile',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'compile',
		],
	},
	'check-types': 'tsc --noEmit --pretty false',
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
