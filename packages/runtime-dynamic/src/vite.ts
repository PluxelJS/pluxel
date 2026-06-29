import { resolve } from 'node:path'
import { pluxelRuntimeSourceVitePlugin } from '@pluxel/runtime-dev/vite'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'

import type { BuiltinPluginSpec } from './services'
import type { BootedLoaderHmrHost, LoaderHmrHostStorageOptions } from './hmr/host'
import type { LoaderHmrDependencyConfig } from './hmr/engine/config'
import type { LoaderHmrConfig } from './hmr/engine/LoaderHmrService'
import { createFetchHmrServerPlugin } from './hmr/vite-fetch-plugin'

const DYNAMIC_RUNTIME_CONFIG_MARKER = Symbol.for('pluxel.dynamicRuntimeViteConfig')
const DYNAMIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.dynamicRuntimeVitePlugin')

export type DynamicRuntimeViteConfig = {
	root?: string
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
	logsDir?: string
	logFile?: string
	storage?: LoaderHmrHostStorageOptions
	warmup?: boolean
	printUrls?: boolean
	deps?: LoaderHmrDependencyConfig
	cjsExternal?: readonly string[]
	builtins?: readonly BuiltinPluginSpec[]
	builtinsFromDist?: LoaderHmrConfig['builtinsFromDist']
	context?: Record<string, unknown>
}

export type DynamicRuntimeVitePluginOptions = {
	config: string
}

type MarkedDynamicRuntimeViteConfig = DynamicRuntimeViteConfig & {
	readonly [DYNAMIC_RUNTIME_CONFIG_MARKER]?: true
}

type DynamicRuntimeController = {
	booted: BootedLoaderHmrHost
	configFiles: Set<string>
	stop(): Promise<void>
}

export function defineDynamicRuntimeConfig(
	config: DynamicRuntimeViteConfig,
): DynamicRuntimeViteConfig {
	if ('vite' in config) {
		throw new Error(
			'[runtime-dynamic/vite] Dynamic runtime config must not include a nested "vite" field; use the host vite.config.ts instead',
		)
	}
	Object.defineProperty(config, DYNAMIC_RUNTIME_CONFIG_MARKER, {
		value: true,
		enumerable: false,
		configurable: false,
	})
	return config
}

export function dynamicRuntimeVitePlugin(options: DynamicRuntimeVitePluginOptions): PluginOption[] {
	const state: {
		server?: ViteDevServer
		configPath?: string
		controller?: DynamicRuntimeController
		httpInstalled?: boolean
	} = {}

	const loadConfig = async (): Promise<DynamicRuntimeViteConfig> => {
		const server = state.server
		if (!server) throw new Error('[runtime-dynamic/vite] Vite server is not configured')
		const configPath = (state.configPath ??= resolveRuntimeConfigPath(
			server,
			options.config,
			'runtime-dynamic',
		))
		const mod = await server.ssrLoadModule(configPath)
		const config = validateDynamicRuntimeConfigModule(mod, configPath)
		state.controller = state.controller
			? {
					...state.controller,
					configFiles: collectSsrImportFiles(server, configPath),
				}
			: state.controller
		return config
	}

	const startController = async (server: ViteDevServer): Promise<DynamicRuntimeController> => {
		const config = await loadConfig()
		await state.controller?.stop()
		const { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } = await import('./hmr/host')
		const plan = await planLoaderHmrHostFromConfig(config)
		const booted = await bootPlannedLoaderHmrHost(plan, { viteServer: server })
		const controller: DynamicRuntimeController = {
			booted,
			configFiles: collectSsrImportFiles(server, state.configPath!),
			stop: async () => {
				await booted.ctx.effects.dispose()
			},
		}
		state.controller = controller
		await booted.hmr.start()
		return controller
	}

	const routePlugin: Plugin = {
		name: 'pluxel:dynamic-runtime',
		apply: 'serve',
		config() {
			return {
				server: {
					watch: {
						ignored: [/\.wrangler/, /\.mf/],
					},
				},
			}
		},
		async configureServer(server) {
			const marked = server as ViteDevServer & { [DYNAMIC_RUNTIME_SERVER_KEY]?: true }
			if (marked[DYNAMIC_RUNTIME_SERVER_KEY]) {
				throw new Error('[runtime-dynamic/vite] only one dynamicRuntimeVitePlugin is allowed')
			}
			marked[DYNAMIC_RUNTIME_SERVER_KEY] = true
			state.server = server
			await startController(server)
			server.httpServer?.once('close', () => {
				void state.controller?.stop()
			})
			installDynamicHttpMiddleware(state, server)
		},
		async handleHotUpdate(ctx) {
			const controller = state.controller
			if (!controller) return
			if (controller.configFiles.has(ctx.file)) {
				state.server = ctx.server
				for (const file of controller.configFiles) {
					for (const mod of ctx.server.moduleGraph.getModulesByFile(file) ?? []) {
						ctx.server.moduleGraph.invalidateModule(mod)
					}
				}
				await startController(ctx.server)
				return []
			}
			if (controller.booted.ctx.http.consumeFullReloadRequest()) {
				ctx.server.ws.send({ type: 'full-reload' })
				return []
			}
			return callViteHook(controller.booted.hmr.vitePlugin.handleHotUpdate, ctx)
		},
		resolveId(id, importer, hookOptions) {
			return callViteHook(
				state.controller?.booted.hmr.vitePlugin.resolveId,
				id,
				importer,
				hookOptions,
			)
		},
		load(id, hookOptions) {
			return callViteHook(state.controller?.booted.hmr.vitePlugin.load, id, hookOptions)
		},
	}

	return [
		pluxelRuntimeSourceVitePlugin({
			name: 'pluxel:dynamic-runtime-source',
			serverOnlyName: 'pluxel:dynamic-runtime-transform',
		}),
		routePlugin,
	]
}

function isDynamicRuntimeConfig(value: unknown): value is DynamicRuntimeViteConfig {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as MarkedDynamicRuntimeViteConfig)[DYNAMIC_RUNTIME_CONFIG_MARKER] === true,
	)
}

function resolveRuntimeConfigPath(server: ViteDevServer, config: string, route: string): string {
	const raw = String(config ?? '').trim()
	if (!raw) throw new Error(`[${route}/vite] config is required`)
	return normalizePath(resolve(server.config.root, raw))
}

function validateDynamicRuntimeConfigModule(
	mod: Record<string, unknown>,
	configPath: string,
): DynamicRuntimeViteConfig {
	const value = mod.default
	if (value && typeof (value as Promise<unknown>).then === 'function') {
		throw new Error(
			`[runtime-dynamic/vite] ${configPath} default export must be a plain object returned by defineDynamicRuntimeConfig(...), not a Promise`,
		)
	}
	if (!isDynamicRuntimeConfig(value)) {
		throw new Error(
			`[runtime-dynamic/vite] ${configPath} must default-export defineDynamicRuntimeConfig(...)`,
		)
	}
	if ('vite' in value) {
		throw new Error(
			`[runtime-dynamic/vite] ${configPath} must not include a nested "vite" field; use the host vite.config.ts instead`,
		)
	}
	return value
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

function installDynamicHttpMiddleware(
	state: { controller?: DynamicRuntimeController; httpInstalled?: boolean },
	server: ViteDevServer,
): void {
	if (state.httpInstalled) return
	state.httpInstalled = true
	const plugin = createFetchHmrServerPlugin({
		exclude: [
			/^\/@.+$/,
			/^\/node_modules\/.*/,
			/(\.ts|\.tsx)(\?.*)?$/,
			/^\/favicon\.ico$/,
			/^\/static\/.+/,
			/\?t=\d+$/,
		],
		fetch: (req) => {
			const ctx = state.controller?.booted.ctx
			if (!ctx)
				return Promise.resolve(new Response('Dynamic runtime is not ready', { status: 503 }))
			return ctx.http.fetch(req)
		},
		injectClientScript: true,
	})
	callViteHook(plugin.configResolved, server.config)
	callViteHook(plugin.configureServer, server)
}

function callViteHook<TArgs extends unknown[], TResult>(
	hook: unknown,
	...args: TArgs
): TResult | undefined {
	if (!hook) return undefined
	const fn =
		typeof hook === 'function'
			? hook
			: typeof hook === 'object' && typeof (hook as { handler?: unknown }).handler === 'function'
				? (hook as { handler: (...args: TArgs) => TResult }).handler
				: undefined
	if (!fn) return undefined
	return (fn as (...args: TArgs) => TResult)(...args)
}
