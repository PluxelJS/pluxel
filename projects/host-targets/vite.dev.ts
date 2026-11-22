import { resolve } from 'node:path'
import { host, type HostViteOptions } from '@pluxel/host-vite'
import { pluginModules } from '@pluxel/host-vite/modules'
import {
	defaultClientConditions,
	type NormalizedHotChannel,
	type Plugin,
	type PluginOption,
} from 'vite'
import { demoUpdateEvent, type DemoResult, type DemoUpdate } from './src/protocol.ts'

const pluginPackage = '@pluxel-example/host-targets-plugins'

function sourcePlugins(root: string): Plugin[] {
	const packageRoot = resolve(root, 'plugins')
	return [
		{
			name: 'host-targets:source-conditions',
			configEnvironment(name, options) {
				if (name !== 'client' && name !== 'cloudflare') return undefined
				const conditions =
					name === 'client' && !options.resolve?.conditions ? [...defaultClientConditions] : []
				return {
					resolve: { conditions: [...conditions, '@pluxel/hmr'] },
					optimizeDeps: { exclude: [pluginPackage] },
				}
			},
		},
		pluginModules({
			root: packageRoot,
			packageJsonPath: resolve(packageRoot, 'package.json'),
			environments: ['client', 'cloudflare'],
		}),
	]
}

function forwardCloudflareUpdates(): Plugin {
	return {
		name: 'host-targets:cloudflare-updates',
		configureServer(server) {
			server.environments.cloudflare.hot.on(demoUpdateEvent, (update: DemoUpdate) => {
				server.environments.client.hot.send(demoUpdateEvent, update)
			})
		},
	}
}

function nodeDemoEndpoint() {
	let current: ((signal: AbortSignal) => Promise<DemoResult>) | undefined
	let client: NormalizedHotChannel
	let latestError: string | undefined
	const onUpdateSettled: NonNullable<HostViteOptions['onUpdateSettled']> = (update) => {
		latestError =
			update.outcome === 'applied' ? undefined : (update.error?.message ?? update.outcome)
		client.send(demoUpdateEvent, {
			host: 'node',
			error: latestError,
		} satisfies DemoUpdate)
	}
	const plugin = {
		name: 'host-targets:node-endpoint',
		configureServer(server) {
			client = server.environments.client.hot
			server.middlewares.use('/api/node', (request, response) => {
				if (request.method !== 'POST') {
					response.writeHead(405, { allow: 'POST' }).end('Use POST')
					return
				}
				const run = current
				if (!run) {
					response.writeHead(503).end(latestError ?? 'Node Host is unavailable')
					return
				}
				const controller = new AbortController()
				response.once('close', () => controller.abort())
				void (async () => {
					try {
						const result = await run(controller.signal)
						if (response.destroyed) return
						response
							.writeHead(200, { 'content-type': 'application/json' })
							.end(JSON.stringify(result))
					} catch (error) {
						if (!response.destroyed) response.writeHead(500).end(String(error))
					}
				})()
			})
		},
	} satisfies Plugin
	return {
		plugin,
		onUpdateSettled,
		serve(run: NonNullable<typeof current>) {
			current = run
			return () => {
				if (current === run) current = undefined
			}
		},
	}
}

export function demoDevelopment(root: string): PluginOption[] {
	const node = nodeDemoEndpoint()
	return [
		...sourcePlugins(root),
		forwardCloudflareUpdates(),
		node.plugin,
		host({
			entry: './src/node-app.ts',
			bindings: { serve: node.serve },
			onUpdateSettled: node.onUpdateSettled,
		}),
	]
}
