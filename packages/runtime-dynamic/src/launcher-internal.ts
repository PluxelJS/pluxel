import { createServer, type ViteDevServer } from 'vite'
import { dynamicRuntimeVitePlugin } from './vite'

export async function startOwnedDynamicRuntimeViteServer(options: {
	config: string
}): Promise<ViteDevServer> {
	const server = await createServer({
		configFile: false,
		plugins: dynamicRuntimeVitePlugin({ config: options.config }),
		server: { port: 0 },
	})
	try {
		await server.listen()
		return server
	} catch (error) {
		await server.close().catch((): undefined => undefined)
		throw error
	}
}
