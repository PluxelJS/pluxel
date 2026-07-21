import { resolve } from 'node:path'
import { importViteSsrModule } from '@pluxel/runtime-dev/vite'
import { pluxelRuntimeSourceVitePlugins } from '@pluxel/rolldown/vite'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'

import type { BootedLoaderHmrHost } from './hmr/host'
import { isDynamicRuntimeConfig, type DynamicRuntimeConfig } from './config'
import { createFetchHmrServerPlugin } from './hmr/vite-fetch-plugin'
import { isRuntimeHttpRouteRequest } from './hmr/runtime-route-request'
import { DEFAULT_VITE_WATCH_IGNORED, VITE_WATCH_USE_POLLING } from './hmr/vite-watch'

const DYNAMIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.dynamicRuntimeVitePlugin')
const DYNAMIC_RUNTIME_CACHE_DIR = '.pluxel/vite/dynamic-runtime'

export type DynamicRuntimeVitePluginOptions = {
	config: string
	/**
	 * Runs after the loader HMR host is created and before HMR/plugin startup.
	 * Use this for host-owned bootstrapping such as preparing or unlocking vault storage.
	 */
	prepareHost?: (host: BootedLoaderHmrHost) => void | Promise<void>
}

type DynamicRuntimeController = {
	booted: BootedLoaderHmrHost
	configFiles: Set<string>
	stop(): Promise<void>
}

export function dynamicRuntimeVitePlugin(options: DynamicRuntimeVitePluginOptions): PluginOption[] {
	const state: {
		server?: ViteDevServer
		configPath?: string
		controller?: DynamicRuntimeController
		httpInstalled?: boolean
	} = {}

	const loadConfig = async (): Promise<DynamicRuntimeConfig> => {
		const server = state.server
		if (!server) throw new Error('[runtime-dynamic/vite] Vite server is not configured')
		const configPath = (state.configPath ??= resolveRuntimeConfigPath(
			server,
			options.config,
			'runtime-dynamic',
		))
		const mod = await importViteSsrModule(server, configPath, { fresh: true })
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
		await options.prepareHost?.(booted)
		const controller: DynamicRuntimeController = {
			booted,
			configFiles: collectSsrImportFiles(server, state.configPath!),
			stop: async () => {
				await booted.stop()
			},
		}
		state.controller = controller
		await booted.hmr.start()
		return controller
	}

	const routePlugin: Plugin = {
		name: 'pluxel:dynamic-runtime',
		apply: 'serve',
		config(config) {
			return {
				...(config.cacheDir === undefined ? { cacheDir: DYNAMIC_RUNTIME_CACHE_DIR } : {}),
				server: {
					watch: {
						ignored: [...DEFAULT_VITE_WATCH_IGNORED],
						usePolling: VITE_WATCH_USE_POLLING,
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
		...pluxelRuntimeSourceVitePlugins({
			name: 'pluxel:dynamic-runtime-source',
		}),
		routePlugin,
	]
}

function resolveRuntimeConfigPath(server: ViteDevServer, config: string, route: string): string {
	const raw = String(config ?? '').trim()
	if (!raw) throw new Error(`[${route}/vite] config is required`)
	return normalizePath(resolve(server.config.root, raw))
}

function validateDynamicRuntimeConfigModule(
	mod: Record<string, unknown>,
	configPath: string,
): DynamicRuntimeConfig {
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
	if ('hmr' in value) {
		throw new Error(
			`[runtime-dynamic/vite] ${configPath} must not include an "hmr" field; loader HMR belongs to @pluxel/runtime-dynamic internals and host Vite wiring`,
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
		shouldHandle: (req) => {
			const ctx = state.controller?.booted.ctx
			return Boolean(ctx && isRuntimeHttpRouteRequest(req, ctx))
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
