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
						'!packages/services/dist/**',
						'!packages/services/public/**',
					].map((pattern) => ({ pattern, base: 'workspace' as const })),
				},
			},
			'check-tests': {
				command: 'vp test run',
				dependsOn: [
					'compile',
					'@pluxel/cli#compile',
					{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] },
					'@pluxel/test#compile',
				],
			},
			'check-types': 'tsc --noEmit --pretty false',
		}),
	},
})
