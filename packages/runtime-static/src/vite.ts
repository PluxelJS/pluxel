import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	pluxelRuntimeSourceVitePlugin,
	pluxelRuntimeUiBridgeVitePlugin,
} from '@pluxel/runtime-dev/vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
	normalizePath,
	type InlineConfig,
	type Plugin,
	type PluginOption,
	type ViteDevServer,
} from 'vite'

import { reloadStaticRuntime } from './hmr'
import { defineStaticRuntimeConfig, isStaticRuntimeConfig } from './config'
import { createStaticRuntimeHost } from './internal/host'
import type {
	StaticRuntimeDefinition,
	StaticRuntimeHost,
	StaticRuntimeHostOptions,
	StaticRuntimeStartupReport,
	StaticRuntimeConfig,
} from './types'

const STATIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.staticRuntimeVitePlugin')

type ExtensionCompilerConfig = {
	enabled?: boolean
	cacheDir?: string
	cacheKeep?: number
	compileConcurrency?: number
	sharedPackages?: string[]
	pluginDirs?: Record<string, string>
	vite?: InlineConfig
}

type StaticRuntimeViteHmrConfig = {
	extensionCompiler?: ExtensionCompilerConfig
	enableWebManagement?: boolean
}

type StaticRuntimeDevRuntimeOptions = StaticRuntimeViteHmrConfig & {
	viteServer?: ViteDevServer
}

export type StaticRuntimeViteConfig = StaticRuntimeConfig

export type StaticRuntimeVitePluginOptions = {
	config: string
	hmr?: false | StaticRuntimeViteHmrConfig
}

export { defineStaticRuntimeConfig }

export function staticRuntimeVitePlugin(options: StaticRuntimeVitePluginOptions): PluginOption[] {
	const state: {
		server?: ViteDevServer
		configPath?: string
		configFiles: Set<string>
		runtimeConfig?: StaticRuntimeViteConfig
		host?: StaticRuntimeHost
		stopPromise?: Promise<void>
	} = {
		configFiles: new Set(),
	}

	const loadConfig = async (): Promise<StaticRuntimeViteConfig> => {
		const server = state.server
		if (!server) throw new Error('[runtime-static/vite] Vite server is not configured')
		const configPath = (state.configPath ??= resolveRuntimeConfigPath(
			server,
			options.config,
			'runtime-static',
		))
		const mod = await server.ssrLoadModule(configPath)
		const loaded = validateStaticRuntimeConfigModule(mod, configPath)
		state.configFiles = collectSsrImportFiles(server, configPath)
		state.runtimeConfig = loaded
		return loaded
	}

	async function stopHost(): Promise<void> {
		if (!state.host) return
		state.stopPromise ??= state.host.stop()
		await state.stopPromise
	}

	const routePlugin: Plugin = {
		name: 'pluxel:static-runtime',
		apply: 'serve',
		async configureServer(server) {
			const marked = server as ViteDevServer & { [STATIC_RUNTIME_SERVER_KEY]?: true }
			if (marked[STATIC_RUNTIME_SERVER_KEY]) {
				throw new Error('[runtime-static/vite] only one staticRuntimeVitePlugin is allowed')
			}
			marked[STATIC_RUNTIME_SERVER_KEY] = true
			state.server = server
			const config = await loadConfig()
			const hmr = options.hmr
			const hmrOptions = hmr === false ? undefined : (hmr ?? {})
			if (hmrOptions && hmrOptions.enableWebManagement !== false) {
				await import('@pluxel/runtime/services/web-management')
			}
			const host = await createStaticRuntimeHost(toStaticRuntimeDefinition(config), {
				configService: config.configService,
				runtimeState: config.runtimeState,
				persistence: config.persistence,
				pluginData: config.pluginData,
				http: config.http,
				logger: config.logger,
				profile: config.profile,
				context: config.context,
			})
			state.host = host

			if (hmrOptions && hmrOptions.enableWebManagement !== false) {
				const enabledHmrOptions = hmrOptions ?? {}
				const pluginDirs = resolveStaticRuntimePluginDirs(server, host)
				await configureStaticRuntimeDevRuntime(server, host, {
					viteServer: server,
					...enabledHmrOptions,
					extensionCompiler: mergeExtensionCompilerPluginDirs(
						enabledHmrOptions.extensionCompiler,
						pluginDirs,
					),
				})
			}

			const startup = await host.start()
			logStaticRuntimeStarted(host, startup)

			server.httpServer?.once('close', () => {
				void stopHost()
			})

			server.middlewares.use((req, res, next) => {
				if (!isStaticRuntimeRouteRequest(req)) {
					next()
					return
				}
				void proxyToStaticRuntime(req, res, server, host, next)
			})
		},
		async handleHotUpdate(ctx) {
			const host = state.host
			if (!host || !state.configFiles.has(ctx.file)) return
			const server = state.server ?? ctx.server
			state.server = server
			for (const file of state.configFiles) {
				for (const mod of server.moduleGraph.getModulesByFile(file) ?? []) {
					server.moduleGraph.invalidateModule(mod)
				}
			}
			const config = await loadConfig()
			await reloadStaticRuntime({
				host,
				definition: toStaticRuntimeDefinition(config),
			})
			return []
		},
	}

	return [
		createStaticRuntimeSourcePlugin(),
		staticRuntimeBuildUiBridgeVitePlugin(),
		routePlugin,
	]
}

function logStaticRuntimeStarted(
	host: StaticRuntimeHost,
	startup: StaticRuntimeStartupReport,
): void {
	host.ctx.logger.info('Static runtime Vite host ready', {
		runtime: host.definition.name,
		startup: startup.entries.map(({ name, status }) => `${name}:${status}`),
	})
}

function staticRuntimeBuildUiBridgeVitePlugin(): PluginOption {
	const plugin = pluxelRuntimeUiBridgeVitePlugin()
	const withBuildApply = (item: PluginOption): PluginOption => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return item
		return { ...(item as Plugin), apply: 'build' }
	}
	return Array.isArray(plugin) ? plugin.map(withBuildApply) : withBuildApply(plugin)
}

function createStaticRuntimeSourcePlugin(): Plugin {
	return pluxelRuntimeSourceVitePlugin({
		name: 'pluxel:static-runtime-source',
		serverOnlyName: 'pluxel:static-runtime-transform',
	})
}

function resolveRuntimeConfigPath(server: ViteDevServer, config: string, route: string): string {
	const raw = String(config ?? '').trim()
	if (!raw) throw new Error(`[${route}/vite] config is required`)
	return normalizePath(resolve(server.config.root, raw))
}

function validateStaticRuntimeConfigModule(
	mod: Record<string, unknown>,
	configPath: string,
): StaticRuntimeViteConfig {
	const value = mod.default
	if (value && typeof (value as Promise<unknown>).then === 'function') {
		throw new Error(
			`[runtime-static/vite] ${configPath} default export must be a plain object returned by defineStaticRuntimeConfig(...), not a Promise`,
		)
	}
	if (!isStaticRuntimeConfig(value)) {
		throw new Error(
			`[runtime-static/vite] ${configPath} must default-export defineStaticRuntimeConfig(...)`,
		)
	}
	if ('vite' in value) {
		throw new Error(
			`[runtime-static/vite] ${configPath} must not include a nested "vite" field; use the host vite.config.ts instead`,
		)
	}
	if ('hmr' in value) {
		throw new Error(
			`[runtime-static/vite] ${configPath} must not include an "hmr" field; pass staticRuntimeVitePlugin({ hmr }) options from the host vite.config.ts instead`,
		)
	}
	return value
}

function toStaticRuntimeDefinition(config: StaticRuntimeViteConfig): StaticRuntimeDefinition {
	return {
		name: config.name,
		plugins: config.plugins,
	}
}

function collectSsrImportFiles(server: ViteDevServer, entry: string): Set<string> {
	type ModuleLike = {
		file?: string | null
		importedModules?: Set<ModuleLike>
	}

	const files = new Set<string>([normalizePath(entry)])
	const queue: ModuleLike[] = []
	for (const mod of server.moduleGraph.getModulesByFile(entry) ?? []) queue.push(mod as ModuleLike)

	while (queue.length > 0) {
		const mod = queue.shift()!
		if (mod.file) files.add(normalizePath(mod.file))
		for (const imported of mod.importedModules ?? []) {
			if (imported.file && !files.has(normalizePath(imported.file))) {
				queue.push(imported)
			}
		}
	}
	return files
}

async function configureStaticRuntimeDevRuntime(
	server: ViteDevServer,
	host: StaticRuntimeHost,
	options: StaticRuntimeDevRuntimeOptions,
): Promise<void> {
	const runtimeDev = await loadStaticRuntimeDevModule(server)
	const ctx = host.ctx
	const previousRoute = ctx.runtimeRoute
	if (previousRoute?.dev?.uiSource) {
		throw new Error('[runtime-static/vite] extension source UI runtime is already attached')
	}
	if (!previousRoute) {
		throw new Error('[runtime-static/vite] static route capabilities must be registered first')
	}

	const extensionCompilerConfig = runtimeDev.mergeExtensionCompilerViteConfig(
		options.extensionCompiler,
		undefined,
	)
	ctx.config.extensionCompiler = extensionCompilerConfig
	if (options.enableWebManagement !== false) {
		await import('@pluxel/runtime/services/web-management')
		ctx.config.http = withDevWebManagementHttpConfig(ctx.config.http)
		ctx.config.extensionService = {
			...ctx.config.extensionService,
			enabled: true,
		}
	}

	const extensionStore = ctx.ext.ui
	extensionStore.reconfigure(ctx.config.extensionService)
	const extensionCompiler = new runtimeDev.ExtensionCompilerService(
		ctx,
		{ store: extensionStore, viteServer: options.viteServer, enabled: true },
		extensionCompilerConfig,
	)

	ctx.runtimeRoute = {
		...previousRoute,
		dev: {
			...previousRoute?.dev,
			uiSource: {
				bind: (ownerCtx, declaration) =>
					extensionCompiler.bindDeclaration(ownerCtx, declaration),
			},
		},
	}

	ctx.effects.defer(() => {
		extensionCompiler.dispose()
		ctx.runtimeRoute = previousRoute
	})
}

function withDevWebManagementHttpConfig(
	config: StaticRuntimeConfig['http'] | undefined,
): StaticRuntimeConfig['http'] {
	const next = {
		...config,
		management: true,
		controlPlane: { web: true, rpc: true, sse: true },
		uiAssets: 'dev-server',
	}
	return next
}

async function loadStaticRuntimeDevModule(
	server: ViteDevServer,
): Promise<typeof import('@pluxel/runtime-dev')> {
	const sourceEntry = fileURLToPath(new URL('../../runtime-dev/src/index.ts', import.meta.url))
	if (existsSync(sourceEntry)) {
		return server.ssrLoadModule(sourceEntry) as Promise<typeof import('@pluxel/runtime-dev')>
	}
	return import('@pluxel/runtime-dev')
}

function isStaticRuntimeRouteRequest(request: IncomingMessage): boolean {
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
	config: ExtensionCompilerConfig | undefined,
	pluginDirs: Record<string, string> | undefined,
): ExtensionCompilerConfig | undefined {
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
	await new Promise<void>((resolveStream, reject) => {
		Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolveStream)
			.on('error', reject)
	})
}
