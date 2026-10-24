import { repositoryTasks } from '../../scripts/vite-tasks'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
	run: {
		tasks: {
			'prepare-dev': {
				command: [],
				dependsOn: [
					'compile-report-card-css',
					{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] },
				],
			},
			...repositoryTasks({
				'compile-report-card-css': {
					command: 'node scripts/compile-report-card-css.mjs',
					cache: { output: ['src/showcase/report-card-css.ts'] },
				},
				compile: {
					command: 'node ../../scripts/pack.mjs',
					dependsOn: ['prepare-dev'],
				},
				'check-tests': {
					command: 'vp test run --config vitest.config.ts',
					dependsOn: ['compile'],
				},
				'check-types': 'tsc --noEmit --pretty false',
			}),
		},
	},
	appType: 'spa',
	ssr: { noExternal: ['@opentelemetry/resources'] },
	plugins: lazyPlugins(async () => {
		const { hostEnv } = (await import(
			import.meta.resolve('@pluxel/host/environment')
		)) as typeof import('@pluxel/host/environment')
		const { vitePreset } = (await import(
			import.meta.resolve('@pluxel/services/vite')
		)) as typeof import('@pluxel/services/vite')
		return [
			{
				name: 'pluxel-plugin-host-listener',
				config: () => ({
					server: {
						host: hostEnv.hostBind ?? '127.0.0.1',
						port: hostEnv.hostPort ?? 3310,
						strictPort: hostEnv.hostPort !== undefined,
					},
				}),
			},
			vitePreset({ entry: './src/app.ts', devConsole: true }),
		]
	}),
})
