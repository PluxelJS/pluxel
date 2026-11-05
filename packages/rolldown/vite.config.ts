import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	pack: packConfig,
	run: {
		tasks: repositoryTasks({
			'check-tests': {
				command: 'vp test run',
				dependsOn: [
					'compile',
					{
						task: 'compile',
						from: ['dependencies', 'devDependencies', 'peerDependencies'],
					},
				],
				// Container bind mounts must see the caller's temporary directory too.
				cache: { env: ['PLUXEL_HEADLESS_IMAGE', 'TMPDIR'] },
			},
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/core#compile', 'valibot-form#compile'],
				cache: {
					input: [
						'packages/workbench/package.json',
						'packages/host/package.json',
						'packages/host/src/shared-runtime.ts',
						'packages/workbench/src/workbench/shared-transport.ts',
						'packages/workbench/src/workbench/definition.ts',
					].map((pattern) => ({ pattern, base: 'workspace' as const })),
					output: ['dist/**'],
				},
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
