import { repositoryTasks } from '../../scripts/vite-tasks'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig(({ command, isPreview, mode }) => {
	const node = command === 'build' && mode === 'node'
	const dev = command === 'serve' && !isPreview
	return {
		root: import.meta.dirname,
		run: {
			tasks: {
				'prepare-dev': {
					command: [],
					cache: false,
					dependsOn: [
						'@pluxel-example/host-targets-plugins#compile',
						'@pluxel/agent-sdk#compile',
						'@pluxel/host-vite#compile',
					],
				},
				...repositoryTasks({
					compile: {
						command: [],
						dependsOn: ['compile-web', 'compile-node'],
						cache: false,
					},
					'compile-web': {
						command: 'vp build',
						dependsOn: ['prepare-dev'],
						cache: {
							env: ['VITE_GREETING_NAME'],
							output: ['dist/client/**', 'dist/cloudflare/**', '.wrangler/deploy/config.json'],
						},
					},
					'compile-node': {
						command: 'vp build --mode node',
						dependsOn: ['prepare-dev'],
						cache: { output: ['dist/node/**'] },
					},
					'check-smoke': {
						command: 'node scripts/smoke.mjs',
						dependsOn: ['prepare-dev'],
						cache: false,
					},
					'check-types': {
						command: 'tsc && tsc -p src/cloudflare',
						dependsOn: ['prepare-dev'],
					},
				}),
			},
		},
		oxc: { decorator: { legacy: true } },
		build: {
			target: 'esnext',
			...(node ? { ssr: 'src/node-main.ts', outDir: 'dist/node', copyPublicDir: false } : {}),
		},
		worker: { format: 'es' },
		plugins: lazyPlugins(async () => {
			if (node) return []

			const { cloudflare } = await import('@cloudflare/vite-plugin')
			const edge = cloudflare({ viteEnvironment: { name: 'cloudflare' }, persistState: false })
			if (!dev) return edge

			const { demoDevelopment } = (await import(
				import.meta.resolve('./vite.dev.ts')
			)) as typeof import('./vite.dev')
			return [edge, ...demoDevelopment(import.meta.dirname)]
		}),
	}
})
