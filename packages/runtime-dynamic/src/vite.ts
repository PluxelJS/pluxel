import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'
import { createPluginSourceVitePipeline } from '../../rolldown/src/vite/index.ts'
import {
	collectViteSsrImportFiles,
	createHostModuleVitePlugin,
	createViteNodeElysiaApplicationCarrier,
	createWorkbenchViteClientConfig,
	importViteSsrModule,
	invalidateViteModuleGraphFiles,
	registerViteSsrExternalModuleUrls,
} from '../../runtime-dev/src/vite.ts'
import { resolveDevWorkbenchClientEntryUrl } from '../../runtime/src/server/assets.ts'
import {
	getCachedResolver,
	getOxcResolveCache,
	PLUXEL_DIST_EXPORT_CONDITIONS,
	readHostProduct,
	requireRuntimeHttpService,
	resolveModulePath,
	sameProduct,
	type OxcResolver,
} from '@pluxel/runtime/internal'
import type { ProductDescriptor } from '@pluxel/runtime/product'

import type { BootedLoaderHmrHost } from './hmr/host'
import {
	assertDynamicRuntimeConfig,
	isDynamicRuntimeConfig,
	type DynamicRuntimeConfig,
} from './config'
import { createFetchHmrServerPlugin } from './hmr/vite-fetch-plugin'
import { isRuntimeHttpRouteRequest } from './hmr/runtime-route-request'
import { DEFAULT_VITE_WATCH_IGNORED, VITE_WATCH_USE_POLLING } from './hmr/vite-watch'
import { isPackageInstalledFrom } from './host-package'
import { isPublicElysiaSingletonSpecifier } from './elysia-singleton'

const DYNAMIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.dynamicRuntimeVitePlugin')
const DYNAMIC_RUNTIME_CONTROLLER_KEY = Symbol.for('pluxel.dynamicRuntimeController')
const DYNAMIC_RUNTIME_CACHE_DIR = '.pluxel/vite/dynamic-runtime-v2'
const HOST_SINGLETON_VIRTUAL_PREFIX = '\0pluxel:dynamic-host-singleton:'
const moduleDir = dirname(fileURLToPath(import.meta.url))
const RUNTIME_SOURCE_ROOT = normalizePath(
	resolve(fileURLToPath(new URL('../../runtime/src/', import.meta.url))),
)
const RUNTIME_DIST_ROOT = normalizePath(
	resolve(fileURLToPath(new URL('../../runtime/dist/', import.meta.url))),
)
const CORE_SOURCE_ROOT = normalizePath(
	resolve(fileURLToPath(new URL('../../core/src/', import.meta.url))),
)
const CORE_DIST_ROOT = normalizePath(
	resolve(fileURLToPath(new URL('../../core/dist/', import.meta.url))),
)
const CONTEXT_SOURCE_ROOT = normalizePath(
	resolve(fileURLToPath(new URL('../../context/src/', import.meta.url))),
)
const CONTEXT_DIST_ROOT = normalizePath(
	resolve(fileURLToPath(new URL('../../context/dist/', import.meta.url))),
)

export type DynamicRuntimeVitePluginOptions = {
	config: string
	/**
	 * `development` resolves source exports and serves the Workbench source graph.
	 * `distribution` resolves built package exports and serves the packaged Workbench bundle.
	 */
	mode?: 'development' | 'distribution'
	/**
	 * Runs after the loader HMR host is created and before HMR/plugin startup.
	 * Use this for host-owned bootstrapping such as preparing or unlocking vault storage.
	 */
	prepareHost?: (host: BootedLoaderHmrHost) => void | Promise<void>
}

type DynamicRuntimeController = {
	booted: BootedLoaderHmrHost
	product: ProductDescriptor | null
	stop(): Promise<void>
}

type DynamicViteApplicationCarrier = ReturnType<typeof createViteNodeElysiaApplicationCarrier>

export function dynamicRuntimeVitePlugin(options: DynamicRuntimeVitePluginOptions): PluginOption[] {
	const mode = options.mode ?? 'development'
	const sourcePipeline = createPluginSourceVitePipeline({
		name: 'pluxel:dynamic-runtime-source',
		packageMode: mode,
	})
	let singletonHostRoot: string | null = null
	let singletonHostResolver: OxcResolver | null = null
	let contextHostHasContext: boolean | undefined
	const canonicalElysiaUrls = new Map<string, string>()
	let unregisterElysiaExternalModules: (() => void) | undefined
	const state: {
		server?: ViteDevServer
		configPath?: string
		configFiles?: Set<string>
		controller?: DynamicRuntimeController
		httpInstalled?: boolean
		applicationCarrier?: DynamicViteApplicationCarrier
		closeHttp?: () => Promise<void>
	} = {}

	const loadConfig = async (): Promise<{
		config: DynamicRuntimeConfig
		product: ProductDescriptor | null
	}> => {
		const server = state.server
		if (!server) throw new Error('[runtime-dynamic/vite] Vite server is not configured')
		const configPath = (state.configPath ??= resolveRuntimeConfigPath(
			server,
			options.config,
			'runtime-dynamic',
		))
		let mod: Record<string, unknown>
		try {
			mod = await importViteSsrModule(server, configPath, { fresh: true })
		} finally {
			// Keep config ownership even when evaluation or the next generation fails so a later
			// config/dependency edit can retry startup without a live controller.
			state.configFiles = collectViteSsrImportFiles(server, configPath)
		}
		return {
			config: validateDynamicRuntimeConfigModule(mod, configPath),
			product: readHostProduct(mod, `[runtime-dynamic/vite] ${configPath}`),
		}
	}

	const startController = async (server: ViteDevServer): Promise<DynamicRuntimeController> => {
		const loaded = await loadConfig()
		const previous = state.controller
		state.controller = undefined
		delete (server as unknown as Record<PropertyKey, unknown>)[DYNAMIC_RUNTIME_CONTROLLER_KEY]
		await previous?.stop()
		const {
			bootPlannedLoaderHmrHost,
			configureLoaderHmrWorkbenchProducerSource,
			planLoaderHmrHostFromConfig,
		} = await loadDynamicHmrHostModule(server)
		const plan = await planLoaderHmrHostFromConfig(loaded.config, {
			configModuleId: state.configPath,
		})
		const booted = await bootPlannedLoaderHmrHost(plan, {
			viteServer: server,
			product: loaded.product,
			workbenchAssets: mode === 'distribution' ? 'built' : 'source',
			workbenchArtifactCacheDir:
				mode === 'distribution'
					? resolve(plan.runtimeStorage.persistenceDir, '..', 'workbench-artifacts')
					: undefined,
		})
		configureLoaderHmrWorkbenchProducerSource(booted.hmr, {
			compilations: () => sourcePipeline.semantics.workbenchCompilations(),
		})
		const applicationCarrier = state.applicationCarrier
		if (!applicationCarrier) {
			await booted.stop()
			throw new Error('[runtime-dynamic/vite] Elysia application carrier is not configured')
		}
		const detachApplicationCarrier = requireRuntimeHttpService(booted.ctx).attachApplicationCarrier(
			applicationCarrier,
		)
		let stopPromise: Promise<void> | undefined
		try {
			await options.prepareHost?.(booted)
			const controller: DynamicRuntimeController = {
				booted,
				product: loaded.product,
				stop: () => {
					stopPromise ??= booted.stop().finally(detachApplicationCarrier)
					return stopPromise
				},
			}
			state.controller = controller
			;(server as unknown as Record<PropertyKey, unknown>)[DYNAMIC_RUNTIME_CONTROLLER_KEY] =
				controller
			await booted.hmr.start()
			return controller
		} catch (error) {
			state.controller = undefined
			delete (server as unknown as Record<PropertyKey, unknown>)[DYNAMIC_RUNTIME_CONTROLLER_KEY]
			await booted.stop().finally(detachApplicationCarrier)
			throw error
		}
	}

	const routePlugin: Plugin = {
		name: 'pluxel:dynamic-runtime',
		apply: 'serve',
		config(config) {
			const workbenchClient =
				mode === 'development'
					? createWorkbenchViteClientConfig(resolveDevWorkbenchClientEntryUrl())
					: {}
			return {
				...workbenchClient,
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
			state.applicationCarrier = createViteNodeElysiaApplicationCarrier(server, {
				fetch: (request) => {
					const ctx = state.controller?.booted.ctx
					if (!ctx) return new Response('Dynamic runtime is not ready', { status: 503 })
					return requireRuntimeHttpService(ctx).fetch(request)
				},
				matches: (request) => {
					const ctx = state.controller?.booted.ctx
					return Boolean(ctx && requireRuntimeHttpService(ctx).matchesWebSocketRoute(request))
				},
			})
			try {
				await startController(server)
				installDynamicHttpMiddleware(state, server, mode === 'development')
			} catch (error) {
				await state.applicationCarrier.close().catch((): undefined => undefined)
				state.applicationCarrier = undefined
				throw error
			}
		},
		async handleHotUpdate(ctx) {
			if (state.configFiles?.has(normalizePath(ctx.file))) {
				state.server = ctx.server
				invalidateViteModuleGraphFiles(ctx.server, state.configFiles)
				const previousProduct = state.controller?.product ?? null
				const next = await startController(ctx.server)
				if (!sameProduct(previousProduct, next.product)) {
					ctx.server.ws.send({ type: 'full-reload' })
				}
				return []
			}
			const controller = state.controller
			if (!controller) return
			if (requireRuntimeHttpService(controller.booted.ctx).consumeFullReloadRequest()) {
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
		async closeBundle() {
			const applicationCarrier = state.applicationCarrier
			applicationCarrier?.stopAccepting()
			const controller = state.controller
			state.controller = undefined
			if (state.server) {
				delete (state.server as unknown as Record<PropertyKey, unknown>)[
					DYNAMIC_RUNTIME_CONTROLLER_KEY
				]
			}
			let controllerError: unknown
			try {
				await controller?.stop()
			} catch (error) {
				controllerError = error
			}
			let httpError: unknown
			try {
				await state.closeHttp?.()
			} catch (error) {
				httpError = error
			}
			state.closeHttp = undefined
			state.applicationCarrier = undefined
			let carrierError: unknown
			try {
				await applicationCarrier?.close()
			} catch (error) {
				carrierError = error
			}
			const errors = [controllerError, httpError, carrierError].filter(
				(error) => error !== undefined,
			)
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1) {
				throw new AggregateError(errors, '[runtime-dynamic/vite] carrier shutdown failed')
			}
		},
	}
	const singletonBridgePlugin: Plugin = {
		name: 'pluxel:dynamic-singleton-bridge',
		enforce: 'pre',
		config() {
			return {
				resolve: {
					dedupe: ['elysia'],
				},
				ssr: {
					external: ['@pluxel/context', '@pluxel/core', '@pluxel/runtime'],
				},
			}
		},
		configResolved(config) {
			singletonHostRoot = config.root
			contextHostHasContext = undefined
			singletonHostResolver = null
			canonicalElysiaUrls.clear()
		},
		configureServer(server) {
			unregisterElysiaExternalModules?.()
			unregisterElysiaExternalModules = registerViteSsrExternalModuleUrls(
				server,
				canonicalElysiaUrls,
			)
		},
		resolveId(id, _importer, hookOptions) {
			if (!hookOptions?.ssr) return null
			if (!singletonHostRoot) return null
			const getResolver = () =>
				(singletonHostResolver ??= getCachedResolver(
					getOxcResolveCache(),
					'dynamic:host-singleton-bridge',
					[singletonHostRoot!, moduleDir],
					{ limit: 8 },
				))
			if (
				isPublicElysiaSingletonSpecifier(id, (specifier) =>
					Boolean(resolveSingletonHostEntry(getResolver(), specifier)),
				)
			) {
				const hostEntry = resolveSingletonHostEntry(getResolver(), id)
				if (!hostEntry) return null
				const hostUrl = pathToFileURL(hostEntry).href
				canonicalElysiaUrls.set(hostUrl, hostUrl)
				return { id: hostUrl, external: true }
			}
			const specifier = resolveSingletonBridgeSpecifier(id, getResolver)
			if (!specifier) return null
			if (isContextBridgeSpecifier(specifier)) {
				contextHostHasContext ??= isPackageInstalledFrom(singletonHostRoot, '@pluxel/context')
				if (!contextHostHasContext) return null
			}
			if (id === specifier) return null
			return `${HOST_SINGLETON_VIRTUAL_PREFIX}${specifier}`
		},
		load(id) {
			if (!id.startsWith(HOST_SINGLETON_VIRTUAL_PREFIX)) return null
			const specifier = id.slice(HOST_SINGLETON_VIRTUAL_PREFIX.length)
			return `export * from ${JSON.stringify(specifier)}`
		},
		closeBundle() {
			unregisterElysiaExternalModules?.()
			unregisterElysiaExternalModules = undefined
		},
	}

	return [
		singletonBridgePlugin,
		...sourcePipeline.plugins,
		createHostModuleVitePlugin(),
		routePlugin,
	]
}

function resolveSingletonBridgeSpecifier(
	id: string,
	getResolver: () => OxcResolver,
): string | null {
	if (
		isContextBridgeSpecifier(id) ||
		id === '@pluxel/core' ||
		id.startsWith('@pluxel/core/') ||
		id === '@pluxel/runtime' ||
		id.startsWith('@pluxel/runtime/')
	) {
		return id
	}
	const clean = cleanSingletonBridgeId(id)
	return (
		sourcePathToPublicSpecifier(
			clean,
			CONTEXT_SOURCE_ROOT,
			'@pluxel/context',
			isContextBridgeSpecifier,
		) ??
		sourcePathToPublicSpecifier(
			clean,
			CONTEXT_DIST_ROOT,
			'@pluxel/context',
			isContextBridgeSpecifier,
		) ??
		sourcePathToPublicSpecifier(clean, RUNTIME_SOURCE_ROOT, '@pluxel/runtime', (specifier) =>
			Boolean(resolveSingletonHostEntry(getResolver(), specifier)),
		) ??
		sourcePathToPublicSpecifier(clean, RUNTIME_DIST_ROOT, '@pluxel/runtime', (specifier) =>
			Boolean(resolveSingletonHostEntry(getResolver(), specifier)),
		) ??
		sourcePathToPublicSpecifier(clean, CORE_SOURCE_ROOT, '@pluxel/core', (specifier) =>
			Boolean(resolveSingletonHostEntry(getResolver(), specifier)),
		) ??
		sourcePathToPublicSpecifier(clean, CORE_DIST_ROOT, '@pluxel/core', (specifier) =>
			Boolean(resolveSingletonHostEntry(getResolver(), specifier)),
		)
	)
}

function cleanSingletonBridgeId(id: string): string {
	const raw = id.split('?', 1)[0]!
	if (raw.startsWith('file://')) {
		try {
			return normalizePath(fileURLToPath(raw))
		} catch {
			return normalizePath(raw)
		}
	}
	return normalizePath(raw.startsWith('/@fs/') ? raw.slice('/@fs'.length) : raw)
}

function isContextBridgeSpecifier(specifier: string): boolean {
	return specifier === '@pluxel/context' || specifier === '@pluxel/context/internal'
}

function resolveSingletonHostEntry(resolver: OxcResolver, specifier: string): string | null {
	return resolveModulePath(resolver, specifier, {
		mode: 'distPreferEsm',
		conditions: ['node', ...PLUXEL_DIST_EXPORT_CONDITIONS],
	})
}

function sourcePathToPublicSpecifier(
	id: string,
	sourceRoot: string,
	packageName: string,
	accept: (specifier: string) => boolean,
): string | null {
	const prefix = sourceRoot.endsWith('/') ? sourceRoot : `${sourceRoot}/`
	if (!id.startsWith(prefix)) return null
	const relative = id.slice(prefix.length).replace(/\.(?:[cm]?[jt]s|tsx)$/, '')
	const specifier = relative === 'index' ? packageName : `${packageName}/${relative}`
	return accept(specifier) ? specifier : null
}

async function loadDynamicHmrHostModule(
	_server: ViteDevServer,
): Promise<
	Pick<
		typeof import('./hmr/host'),
		| 'bootPlannedLoaderHmrHost'
		| 'configureLoaderHmrWorkbenchProducerSource'
		| 'planLoaderHmrHostFromConfig'
	>
> {
	return import('./hmr/host')
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
	assertDynamicRuntimeConfig(value)
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

function installDynamicHttpMiddleware(
	state: {
		controller?: DynamicRuntimeController
		httpInstalled?: boolean
		applicationCarrier?: DynamicViteApplicationCarrier
		closeHttp?: () => Promise<void>
	},
	server: ViteDevServer,
	transformHtml: boolean,
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
			return requireRuntimeHttpService(ctx).fetch(req)
		},
		shouldHandle: (req) => {
			const ctx = state.controller?.booted.ctx
			return Boolean(ctx && isRuntimeHttpRouteRequest(req, ctx))
		},
		...(server.httpServer && state.applicationCarrier
			? {
					businessWebSocket: {
						matches: (request: import('node:http').IncomingMessage) =>
							state.applicationCarrier?.matchesUpgrade(request) ?? false,
						handle: (
							request: import('node:http').IncomingMessage,
							socket: import('node:stream').Duplex,
							head: Buffer,
						) => state.applicationCarrier?.handleUpgrade(request, socket, head),
					},
				}
			: {}),
		transformHtml,
	})
	callViteHook(plugin.configResolved, server.config)
	callViteHook(plugin.configureServer, server)
	state.closeHttp = async () => {
		await callViteHook<[], void | Promise<void>>(plugin.closeBundle)
	}
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
