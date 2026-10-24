import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/cli#compile'],
				cache: {
					input: [
						'packages/cli/scripts/sync-template-catalog.*',
						'scripts/repository-packages.mjs',
						'packages/*/package.json',
						'plugins/*/package.json',
						'plugins/*/*/package.json',
						'pnpm-workspace.yaml',
						'packages/cli/scripts/dependency-policy.*',
						'docs/**',
					].map((pattern) => ({ pattern, base: 'workspace' as const })),
					output: ['dist/**'],
				},
			},
			'check-tests': {
				command: 'vp test run --dir tests',
				dependsOn: [
					{
						task: 'compile',
						from: ['dependencies', 'devDependencies', 'peerDependencies'],
					},
					'compile',
					'@pluxel/test#compile',
				],
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
