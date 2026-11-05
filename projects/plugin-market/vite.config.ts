import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'wrangler deploy --dry-run --outdir dist/worker',
				dependsOn: ['compile-web'],
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
			'serve-local': {
				command: 'wrangler dev',
				dependsOn: ['compile-web'],
				cache: false,
			},
			'serve-sandbox': {
				command: 'node dev/server.ts',
				dependsOn: ['compile-web'],
				cache: false,
			},
			'check-tests': {
				command: 'vp test run --config vitest.config.ts',
				dependsOn: [],
				cache: false,
			},
			'check-types': {
				command: [
					'tsc --noEmit --pretty false',
					'tsc --noEmit --pretty false -p web/tsconfig.json',
				],
				dependsOn: [],
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
