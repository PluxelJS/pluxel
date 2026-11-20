import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { PluginHost } from '@pluxel/host'
import { repositoryTasks } from '../../scripts/vite-tasks'
import {
	isRunnableDevEnvironment,
	normalizePath,
	perEnvironmentPlugin,
	type EnvironmentModuleNode,
	type Plugin,
} from 'vite'
import { defineConfig, lazyPlugins } from 'vite-plus'

const root = import.meta.dirname
const require = createRequire(import.meta.url)

function lowering(): Plugin[] {
	const { configSourcePlugin, createPluginSemanticsPlugin } =
		require('@pluxel/rolldown/plugins') as typeof import('@pluxel/rolldown/plugins')
	return [createPluginSemanticsPlugin({ root }).plugin, configSourcePlugin()] as Plugin[]
}

function browserWorkerUpdates(): Plugin {
	const entry = normalizePath(resolve(root, 'src/browser.worker.ts'))

	function isWorkerModule(
		module: EnvironmentModuleNode,
		seen = new Set<EnvironmentModuleNode>(),
	): boolean {
		if (module.file === entry) return true
		if (seen.has(module)) return false
		seen.add(module)
		return [...module.importers].some((importer) => isWorkerModule(importer, seen))
	}

	return {
		name: 'host-targets:browser-worker-update',
		hotUpdate({ modules }) {
			if (this.environment.name !== 'client') return undefined
			const workers = new Set(modules.filter((module) => isWorkerModule(module)))
			if (workers.size === 0) return undefined
			this.environment.hot.send('host-targets:browser-worker-update')
			return modules.filter((module) => !workers.has(module))
		},
	}
}

function nodeDemoEndpoint() {
	let current: PluginHost | undefined
	return {
		serve(host: PluginHost) {
			current = host
			return () => {
				if (current === host) current = undefined
			}
		},
		plugin: {
			name: 'host-targets:node-endpoint',
			configureServer(server) {
				const environment = server.environments.pluxel
				if (!environment || !isRunnableDevEnvironment(environment)) {
					throw new Error('The Pluxel Vite environment is required')
				}
				server.middlewares.use('/api/node', (request, response) => {
					if (request.method !== 'POST') {
						response.writeHead(405, { allow: 'POST' }).end('Use POST')
						return
					}
					if (!current) {
						response.writeHead(503).end('Node Host is starting')
						return
					}
					const controller = new AbortController()
					response.once('close', () => controller.abort())
					const host = current
					void (async () => {
						try {
							const { runDemo } =
								await environment.runner.import<typeof import('./src/demo')>('/src/demo.ts')
							const result = await runDemo(host, 'node', controller.signal)
							if (response.destroyed) return
							response.writeHead(200, { 'content-type': 'application/json' })
							response.end(JSON.stringify(result))
						} catch (error) {
							if (!response.destroyed) response.writeHead(500).end(String(error))
						}
					})()
				})
			},
		} satisfies Plugin,
	}
}

export default defineConfig(({ command, isPreview, mode }) => {
	const node = command === 'build' && mode === 'node'
	const dev = command === 'serve' && !isPreview
	return {
		root,
		run: {
			tasks: {
				'prepare-dev': {
					command: [],
					cache: false,
					dependsOn: ['@pluxel/agent-sdk#compile', '@pluxel/host-vite#compile'],
				},
				...repositoryTasks({
					compile: {
						command: 'vp build && vp build --mode node',
						dependsOn: ['prepare-dev'],
						cache: { output: ['dist/**', '.wrangler/deploy/config.json'] },
					},
					'check-smoke': {
						command: 'node scripts/smoke.mjs',
						dependsOn: ['compile'],
						cache: false,
					},
					'check-types': 'tsc && tsc -p src/cloudflare',
				}),
			},
		},
		oxc: { decorator: { legacy: true } },
		build: {
			target: 'esnext',
			...(node ? { ssr: 'src/node-main.ts', outDir: 'dist/node', copyPublicDir: false } : {}),
		},
		worker: { format: 'es', plugins: lowering },
		plugins: lazyPlugins(async () => {
			const compiler = {
				...perEnvironmentPlugin('host-targets:lowering', (environment) =>
					environment.name === 'pluxel' ? false : lowering(),
				),
				enforce: 'pre',
			} satisfies Plugin
			if (node) return [compiler]

			const { cloudflare } = await import('@cloudflare/vite-plugin')
			const edge = cloudflare({ viteEnvironment: { name: 'cloudflare' }, persistState: false })
			if (!dev) return [compiler, edge]

			const { host } = await import('@pluxel/host-vite')
			const endpoint = nodeDemoEndpoint()
			return [
				endpoint.plugin,
				host({ entry: './src/node-app.ts', bindings: { serve: endpoint.serve } }),
				compiler,
				browserWorkerUpdates(),
				edge,
			]
		}),
	}
})
