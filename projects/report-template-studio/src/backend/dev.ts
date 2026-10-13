import { resolve } from 'node:path'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { host, closeHostViteSession, type HostVitePluginApi } from '@pluxel/host-vite'
import { serviceSingletons } from '@pluxel/services/vite'
import { nodeArtifacts } from '@pluxel/services/node/vite'
import { StudioRpcCarrier } from '../rpc/carrier.js'
import type { NativeDesktopApi } from '../rpc/targets.js'
import type { BackendConfig, StudioBackend } from './runtime.js'

/** Official host-vite owns Plugin activation and replacement; the carrier owns RPC admission. */
export async function startDevBackend(
	config: BackendConfig,
	projectRoot: string,
): Promise<StudioBackend> {
	const rpc = await StudioRpcCarrier.create(config)
	let server: ViteDevServer | undefined
	let activeAttachment: object | undefined
	const carrier: Plugin<HostVitePluginApi> = {
		name: 'studio:rpc',
		api: {
			pluxelHost: {
				attach(input) {
					const attachment = {}
					activeAttachment = attachment
					const declaration = input.catalog.plugins.find((plugin) => {
						const definition = pluginDefinitionAddressOf(plugin)
						return (
							definition.exportName === 'StudioPlugin' &&
							definition.entry.kind === 'package-subpath' &&
							definition.entry.packageName === '@report-template-studio/app' &&
							definition.entry.subpath === './plugin'
						)
					})
					if (!declaration)
						throw new Error('StudioPlugin is missing from the current application catalog')
					const address = pluginNodeAddressOf(declaration)
					const registry = requirePluginService(input.host.ctx)
					const current = () => registry.getInstance(address) as NativeDesktopApi | undefined
					// Attach precedes activation. The committed-instance watcher publishes readiness.
					const unsubscribe = registry.watchInstance(address, () => {
						if (activeAttachment === attachment) rpc.setApi(current(), current)
					})
					return () => {
						unsubscribe()
						if (activeAttachment === attachment) {
							activeAttachment = undefined
							rpc.setApi(undefined)
						}
					}
				},
			},
		},
	}
	const close = () =>
		rpc.close(async () => {
			activeAttachment = undefined
			if (!server) return
			try {
				await closeHostViteSession(server)
			} finally {
				await server.close()
			}
		})
	try {
		server = await createServer({
			root: resolve(projectRoot),
			cacheDir: resolve(projectRoot, '.studio-dev/vite-backend'),
			optimizeDeps: { noDiscovery: true, include: [] },
			configFile: false,
			appType: 'custom',
			server: { middlewareMode: true, ws: false },
			plugins: [
				serviceSingletons(),
				nodeArtifacts(),
				carrier,
				host({
					entry: './src/backend/application.ts',
					bindings: { ...config, root: rpc.root },
					devConsole: process.platform !== 'win32',
				}),
			],
		})
		await rpc.publish()
		return {
			get api() {
				return rpc.api
			},
			connectDesktopPort: (port, options) => rpc.connectDesktopPort(port, options),
			onReady: (listener) => rpc.onReady(listener),
			close,
		}
	} catch (error) {
		await close()
		throw error
	}
}
