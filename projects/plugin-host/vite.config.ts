import { repositoryTasks } from '../../scripts/vite-tasks'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
	run: {
		tasks: {
			'prepare-dev': {
				command: [],
				dependsOn: [
					{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] },
				],
			},
			...repositoryTasks('@pluxel/plugins-host', {
				build: 'node scripts/compile-report-card-css.mjs && node ../../scripts/pack.mjs',
				test: 'vp test run --config vitest.config.ts',
				typecheck: 'vp exec tsc -p src/tsconfig.json --pretty false',
			}),
		},
	},
	appType: 'spa',
	ssr: { noExternal: ['@opentelemetry/resources'] },
	plugins: lazyPlugins(async () => {
		const { hostEnv } = await import('@pluxel/host/environment')
		const { vitePreset } = await import('@pluxel/services/vite')
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
