import { fileURLToPath } from 'node:url'
import { gqlens } from '@gqlens/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { commercialGraphQLEndpoint } from './src/paths.ts'
const graphQLPackageRoot = fileURLToPath(new URL('node_modules/graphql', import.meta.url))

export default defineConfig({
	appType: 'spa',
	plugins: [
		pluxelStaticCommercialHost(),
		gqlens({
			output: 'web/gqlens',
			entry: '/src/graphql-entry.ts',
			endpoint: commercialGraphQLEndpoint,
			include: [/\/src\//],
			framework: 'react',
			middleware: false,
		}),
		react(),
	],
	resolve: {
		alias: [
			{ find: /^graphql$/, replacement: `${graphQLPackageRoot}/index.mjs` },
			{ find: /^graphql\/(.+)$/, replacement: `${graphQLPackageRoot}/$1` },
		],
	},
	optimizeDeps: {
		exclude: ['graphql', 'graphql-yoga'],
	},
})

function pluxelStaticCommercialHost(): Plugin {
	let stop: (() => Promise<void>) | undefined

	return {
		name: 'pluxel-static-commercial-host',
		apply: 'serve',
		async configureServer(server: ViteDevServer) {
			const staticHostModuleUrl = new URL('./src/static-host.ts', import.meta.url).href
			const { createStaticCommercialHost } = (await import(
				/* @vite-ignore */ staticHostModuleUrl
			)) as typeof import('./src/static-host')
			const host = await createStaticCommercialHost()
			stop = () => host.stop()

			server.httpServer?.once('close', () => {
				void stop?.()
			})

			return () => {
				server.middlewares.use((req, res, next) => {
					if (!shouldProxyToPluxel(req)) {
						next()
						return
					}

					void (async () => {
						const response = await host.fetch(toRequest(req, server))
						await writeResponse(res, response)
					})().catch(next)
				})
			}
		},
	}
}

function shouldProxyToPluxel(req: import('node:http').IncomingMessage): boolean {
	const url = req.url ?? '/'
	if (url.startsWith('/__pluxel/')) return true

	const method = (req.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false

	const accept = String(req.headers.accept ?? '').toLowerCase()
	return accept.includes('text/html')
}

function toRequest(req: import('node:http').IncomingMessage, server: ViteDevServer): Request {
	const address = server.httpServer?.address()
	const port =
		typeof address === 'object' && address
			? address.port
			: (server.config.server.port ?? 5173)
	const origin = `http://127.0.0.1:${port}`
	const method = req.method ?? 'GET'
	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item)
			continue
		}
		headers.set(key, value)
	}

	const init: RequestInit & { duplex?: 'half' } = { method, headers }
	if (method !== 'GET' && method !== 'HEAD') {
		init.body = req as unknown as BodyInit
		init.duplex = 'half'
	}

	return new Request(new URL(req.url ?? '/', origin), init)
}

async function writeResponse(
	res: import('node:http').ServerResponse,
	response: Response,
): Promise<void> {
	res.statusCode = response.status
	response.headers.forEach((value, key) => res.setHeader(key, value))
	if (!response.body) {
		res.end()
		return
	}

	const { Readable } = await import('node:stream')
	await new Promise<void>((resolve, reject) => {
		Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolve)
			.on('error', reject)
	})
}
