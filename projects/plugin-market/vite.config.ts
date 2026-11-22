import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

const workerPrerequisites = [
	'@pluxel/host#compile',
	'@pluxel/host-vite#compile',
	'@pluxel/rolldown#compile',
]

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'wrangler deploy --dry-run --outdir dist/deploy',
				dependsOn: ['compile-web', 'compile-worker'],
				cache: { output: ['dist/deploy/**'] },
			},
			'compile-worker': {
				command: 'node dev/build-worker.ts',
				dependsOn: workerPrerequisites,
				cache: { output: ['dist/worker/**'] },
			},
			'compile-web': {
				command: 'vp build --config web/vite.config.ts',
				dependsOn: [],
				cache: {
					input: [{ pattern: 'plugins/package-manager/src/**', base: 'workspace' }, '!dist/web/**'],
					output: ['dist/web/**'],
					env: ['VITE_MARKET_URL'],
				},
			},
			'compile-mirror': {
				command: 'node dev/build-mirror.ts',
				cache: { output: ['dist/mirror.mjs'] },
			},
			'serve-local': {
				command: 'vp dev --config vite.dev.ts',
				dependsOn: workerPrerequisites,
				cache: false,
			},
			'serve-sandbox': {
				command: 'node dev/server.ts',
				dependsOn: ['compile-web', 'compile-worker'],
				cache: false,
			},
			'check-tests': {
				command: 'vp test run --config vitest.config.ts',
				dependsOn: workerPrerequisites,
				cache: false,
			},
			'check-types': {
				command: [
					'tsc --noEmit --pretty false',
					'tsc --noEmit --pretty false -p web/tsconfig.json',
				],
				dependsOn: workerPrerequisites,
			},
			'prepare-sandbox': {
				command: 'node dev/experience.ts prepare',
				dependsOn: ['@pluxel/cli#compile'],
				cache: false,
			},
			'verify-sandbox': {
				command: 'node dev/experience.ts verify',
				dependsOn: ['@pluxel/cli#compile'],
				cache: false,
			},
		}),
	},
})
