import { repositoryTasks } from '../../scripts/vite-tasks'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
	run: {
		tasks: {
			'prepare-dev': {
				command: 'node ../../scripts/check-worksplit-native.mjs ../../packages/workbench',
				cache: false,
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
		const { resolveHostEnv } = (await import(
			import.meta.resolve('@pluxel/host/environment')
		)) as typeof import('@pluxel/host/environment')
		const { vitePreset } = (await import(
			import.meta.resolve('@pluxel/services/vite')
		)) as typeof import('@pluxel/services/vite')
		const environment = resolveHostEnv({ ...process.env })
		return [
			{
				name: 'pluxel-plugin-host-listener',
				config: () => ({
					server: {
						host: environment.hostBind ?? '127.0.0.1',
						port: environment.hostPort ?? 3310,
						strictPort: environment.hostPort !== undefined,
					},
				}),
			},
			vitePreset({ entry: './src/app.ts', devConsole: true }),
		]
	}),
})
