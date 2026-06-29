import { dirname } from 'node:path'
import {
	pluxelRuntimeSourceVitePlugin,
	pluxelRuntimeUiBridgeVitePlugin,
	type PluxelRuntimeSourceVitePluginOptions,
	type PluxelRuntimeUiBridgeVitePluginOptions,
} from '@pluxel/runtime-dev/vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PluginOption, ViteDevServer } from 'vite'

import type { InstallStaticRuntimeHmrOptions, StaticRuntimeExtensionCompilerConfig } from './hmr'
import type { StaticRuntimeHost, StaticRuntimeStartupReport } from './types'

export type StaticRuntimeSourceVitePluginOptions = Omit<
	PluxelRuntimeSourceVitePluginOptions,
	'serverOnlyName'
>

export type StaticRuntimeUiBridgeVitePluginOptions = PluxelRuntimeUiBridgeVitePluginOptions

export function staticRuntimeSourceVitePlugin(
	options: StaticRuntimeSourceVitePluginOptions = {},
): Plugin {
	return pluxelRuntimeSourceVitePlugin({
		...options,
		name: options.name ?? 'pluxel:static-runtime-source',
		serverOnlyName: 'pluxel:static-runtime-transform',
	})
}

export function staticRuntimeUiBridgeVitePlugin(
	options: StaticRuntimeUiBridgeVitePluginOptions = {},
): PluginOption {
	return pluxelRuntimeUiBridgeVitePlugin(options)
}

export type StaticRuntimeViteHostHmrOptions = Omit<
	InstallStaticRuntimeHmrOptions,
	'host' | 'viteServer'
>

export type StaticRuntimeViteHostPluginOptions = {
	/**
	 * Vite plugin name.
	 *
	 * @default "pluxel:static-runtime-host"
	 */
	name?: string
	/**
	 * Create an unstarted static runtime host. The Vite plugin owns development HMR
	 * installation, startup, request forwarding, and shutdown.
	 */
	createHost(server: ViteDevServer): Promise<StaticRuntimeHost>
	/**
	 * Development source UI support. Enabled by default for Vite hosts.
	 */
	hmr?: false | StaticRuntimeViteHostHmrOptions
	/**
	 * Override which requests should be forwarded to the Pluxel static host.
	 *
	 * By default, `/__pluxel/*` and document navigations are handled by Pluxel; Vite
	 * assets, module requests, and dependency requests stay on Vite.
	 */
	shouldHandleRequest?: StaticRuntimeViteRequestPredicate
	/**
	 * Called after the runtime host starts.
	 */
	onStarted?(input: {
		host: StaticRuntimeHost
		server: ViteDevServer
		startup: StaticRuntimeStartupReport
	}): void | Promise<void>
}

export type StaticRuntimeViteRequestPredicate = (request: IncomingMessage) => boolean

export function staticRuntimeHostVitePlugin(options: StaticRuntimeViteHostPluginOptions): Plugin {
	const shouldHandleRequest = options.shouldHandleRequest ?? shouldHandleStaticRuntimeRequest
	let host: StaticRuntimeHost | undefined
	let stopPromise: Promise<void> | undefined

	async function stopHost(): Promise<void> {
		if (!host) return
		stopPromise ??= host.stop()
		await stopPromise
	}

	return {
		name: options.name ?? 'pluxel:static-runtime-host',
		apply: 'serve',
		async configureServer(server) {
			host = await options.createHost(server)
			if (options.hmr !== false) {
				const hmrOptions = options.hmr ?? {}
				const pluginDirs = resolveStaticRuntimePluginDirs(server, host)
				const { installStaticRuntimeHmr } = await import('./hmr')
				installStaticRuntimeHmr({
					host,
					viteServer: server,
					...hmrOptions,
					extensionCompiler: mergeExtensionCompilerPluginDirs(
						hmrOptions.extensionCompiler,
						pluginDirs,
					),
				})
			}

			const startup = await host.start()
			await options.onStarted?.({ host, server, startup })
			host.ctx.logger.info('Static runtime Vite host ready', {
				runtime: host.definition.name,
				startup: startup.entries.map(({ name, status }) => `${name}:${status}`),
			})

			server.httpServer?.once('close', () => {
				void stopHost()
			})

			return () => {
				server.middlewares.use((req, res, next) => {
					if (!shouldHandleRequest(req)) {
						next()
						return
					}
					void proxyToStaticRuntime(req, res, server, host!, next)
				})
			}
		},
	}
}

export function shouldHandleStaticRuntimeRequest(request: IncomingMessage): boolean {
	const url = request.url ?? '/'
	if (url.startsWith('/__pluxel/')) return true

	const method = (request.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false

	const accept = String(request.headers.accept ?? '').toLowerCase()
	return accept.includes('text/html')
}

type ViteSsrModuleLike = {
	readonly file?: string | null
	readonly ssrModule?: Record<string, unknown> | null
}

function resolveStaticRuntimePluginDirs(
	server: ViteDevServer,
	host: StaticRuntimeHost,
): Record<string, string> | undefined {
	const modules = moduleGraphEntries(server)
	if (modules.length === 0) return undefined

	const pluginDirs: Record<string, string> = {}
	for (const { name, plugin } of host.describeCatalog().plugins) {
		const pluginDir = findSsrExportDir(modules, plugin)
		if (pluginDir) pluginDirs[name] = pluginDir
	}
	return Object.keys(pluginDirs).length > 0 ? pluginDirs : undefined
}

function moduleGraphEntries(server: ViteDevServer): ViteSsrModuleLike[] {
	const graph = server.moduleGraph as unknown as {
		idToModuleMap?: Map<string, ViteSsrModuleLike>
	}
	const values = graph.idToModuleMap?.values()
	return values ? [...values] : []
}

function findSsrExportDir(
	modules: readonly ViteSsrModuleLike[],
	plugin: unknown,
): string | undefined {
	for (const module of modules) {
		if (!module.file || !module.ssrModule) continue
		for (const value of Object.values(module.ssrModule)) {
			if (value === plugin) return dirname(module.file)
		}
	}
	return undefined
}

function mergeExtensionCompilerPluginDirs(
	config: StaticRuntimeExtensionCompilerConfig | undefined,
	pluginDirs: Record<string, string> | undefined,
): StaticRuntimeExtensionCompilerConfig | undefined {
	if (!pluginDirs) return config
	return {
		...config,
		pluginDirs: {
			...pluginDirs,
			...config?.pluginDirs,
		},
	}
}

async function proxyToStaticRuntime(
	req: IncomingMessage,
	res: ServerResponse,
	server: ViteDevServer,
	host: StaticRuntimeHost,
	next: (error?: unknown) => void,
): Promise<void> {
	try {
		const response = await host.ctx.http.fetch(toRequest(req, server))
		await writeResponse(res, response)
	} catch (error) {
		next(error)
	}
}

function toRequest(req: IncomingMessage, server: ViteDevServer): Request {
	const origin = resolveViteOrigin(server)
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

function resolveViteOrigin(server: ViteDevServer): string {
	const address = server.httpServer?.address()
	const port =
		typeof address === 'object' && address ? address.port : (server.config.server.port ?? 5173)
	return `http://127.0.0.1:${port}`
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
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
