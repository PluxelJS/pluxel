import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'node ../../scripts/pack.mjs',
				dependsOn: [
					'@pluxel/commands#compile',
					'@pluxel/host#compile',
					'@pluxel/host-vite#compile',
				],
				cache: {
					input: [
						'packages/workbench/package.json',
						'packages/workbench/tsconfig.json',
						'packages/workbench/src/**',
					].map((pattern) => ({ pattern, base: 'workspace' as const })),
				},
			},
			'check-tests': 'vp test run',
			'check-zenfs-browser': { command: 'node tests/zenfs.browser.mjs', cache: false },
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
