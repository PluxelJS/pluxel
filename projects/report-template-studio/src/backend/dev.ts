import { resolve } from 'node:path'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { host, closeHostViteSession, type HostVitePluginApi } from '@pluxel/host-vite'
import { serviceSingletons } from '@pluxel/services/vite'
import { nodeArtifacts } from '@pluxel/services/node/vite'
import { createElysiaHandler } from '@pluxel/services/elysia'

/** Vite owns backend source updates; Electron only carries Fetch messages. */
export async function startDevBackend(
	config: { root: string; assetsRoot: string },
	projectRoot: string,
) {
	let handler: ReturnType<typeof createElysiaHandler> | undefined
	let server: ViteDevServer | undefined
	let closing: Promise<void> | undefined
	const carrier: Plugin<HostVitePluginApi> = {
		name: 'studio:electron-fetch',
		api: {
			pluxelHost: {
				attach(input) {
					const current = createElysiaHandler(input.host)
					handler = current
					return () => {
						if (handler === current) handler = undefined
					}
				},
			},
		},
	}
	const close = () =>
		(closing ??= (async () => {
			handler = undefined
			if (!server) return
			try {
				await closeHostViteSession(server)
			} finally {
				await server.close()
			}
		})())
	try {
		server = await createServer({
			root: resolve(projectRoot),
			// The renderer owns a separate Vite config and dependency graph.
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
					bindings: config,
					devConsole: process.platform !== 'win32',
				}),
			],
		})
		return {
			fetch: (request: Request) =>
				handler
					? handler(request)
					: Promise.resolve(
							new Response('Studio backend is updating or unavailable', { status: 503 }),
						),
			close,
		}
	} catch (error) {
		await close()
		throw error
	}
}
