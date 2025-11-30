import type { ComponentType } from 'react'
import { ExtensionErrorBoundary } from './ErrorBoundary'
import { extensionRegistry } from './registry'
import type {
	CompiledExtensionBundle,
	ExtensionMeta,
	PluginUIModule,
} from './types'

interface LoadedModule {
	module: PluginUIModule
	cleanups: Array<() => void>
	loadedAt: number
	sourceHash: string
}

const EXTENSION_ROUTE_PREFIX = '/ext/'

function normalizeExtensionRoutePath(path: string): string {
	if (!path) return ''
	const trimmed = path.trim()
	if (!trimmed || trimmed === '/') return ''
	const segments = trimmed
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

function buildExtensionRouteKey(pluginName: string, path: string): string {
	const normalizedPath = normalizeExtensionRoutePath(path)
	if (!normalizedPath) return `${EXTENSION_ROUTE_PREFIX}${pluginName}`
	return `${EXTENSION_ROUTE_PREFIX}${pluginName}${normalizedPath}`
}

function normalizeFullRouteKey(fullPath: string): string {
	if (!fullPath) return fullPath
	const collapsed = fullPath.replace(/\/{2,}/g, '/')
	if (collapsed.length > 1 && collapsed.endsWith('/')) {
		return collapsed.slice(0, -1)
	}
	return collapsed
}

function buildExtensionHref(pluginName: string, path: string): string {
	const normalizedPath = normalizeExtensionRoutePath(path)
	const encodedName = (() => {
		try {
			return encodeURIComponent(pluginName)
		} catch {
			return pluginName
		}
	})()
	if (!normalizedPath) return `${EXTENSION_ROUTE_PREFIX}${encodedName}`
	return `${EXTENSION_ROUTE_PREFIX}${encodedName}${normalizedPath}`
}

function getModuleCacheKey(pluginName: string, sourceHash: string): string {
	return `${pluginName}:${sourceHash || 'dev'}`
}

interface LoadPluginOptions {
	forceReload?: boolean
}

interface SyncManifestOptions {
	forceReload?: boolean
	changedPlugins?: ReadonlySet<string>
}

function appendCacheBustingQuery(url: string, token: string): string {
	return url.includes('?') ? `${url}&${token}` : `${url}?${token}`
}

type RouteComponent = ComponentType

export class ExtensionRuntime {
	private readonly loadedModules = new Map<string, LoadedModule>()
	private readonly moduleCache = new Map<string, PluginUIModule>()
	private readonly routeComponents = new Map<string, RouteComponent>()

	constructor(private readonly registry = extensionRegistry) {}

	isPluginLoaded(pluginName: string): boolean {
		return this.loadedModules.has(pluginName)
	}

	getLoadedModules(): Map<string, { loadedAt: number; sourceHash: string }> {
		const result = new Map<string, { loadedAt: number; sourceHash: string }>()
		for (const [name, mod] of this.loadedModules) {
			result.set(name, { loadedAt: mod.loadedAt, sourceHash: mod.sourceHash })
		}
		return result
	}

	getRouteComponent(fullPath: string): RouteComponent | undefined {
		const normalized = normalizeFullRouteKey(fullPath)
		return this.routeComponents.get(normalized)
	}

	getExtensionRoutes(): Array<{ path: string; pluginName: string }> {
		const routes: Array<{ path: string; pluginName: string }> = []
		for (const key of this.routeComponents.keys()) {
			const match = key.match(/^\/ext\/([^/]+)(.*)$/)
			if (match) {
				routes.push({ path: key, pluginName: match[1]! })
			}
		}
		return routes
	}

	async loadPluginUI(
		pluginName: string,
		bundleUrl: string,
		sourceHash: string,
		options: LoadPluginOptions = {},
	): Promise<boolean> {
		const shouldForceReload = options.forceReload === true
		const existing = this.loadedModules.get(pluginName)
		if (!shouldForceReload && existing && existing.sourceHash === sourceHash) {
			return true
		}

		if (existing) {
			this.unloadPluginUI(pluginName)
		}

		try {
			const cacheKey = getModuleCacheKey(pluginName, sourceHash)
			let mod: PluginUIModule | undefined
			if (!shouldForceReload) {
				mod = this.moduleCache.get(cacheKey)
			}
			if (!mod) {
				const cacheToken =
					shouldForceReload || !sourceHash ? `t=${Date.now()}` : `v=${sourceHash}`
				const urlWithCache = appendCacheBustingQuery(bundleUrl, cacheToken)
				mod = (await import(/* @vite-ignore */ urlWithCache)) as PluginUIModule
				this.moduleCache.set(cacheKey, mod)
			}
			const cleanups: Array<() => void> = []

			if (mod.setup) {
				await mod.setup()
			}

			if (mod.extensions) {
				for (const ext of mod.extensions) {
					const meta: ExtensionMeta = {
						id: `${pluginName}:${ext.point}:${Math.random().toString(36).slice(2)}`,
						pluginName,
						priority: ext.meta?.priority ?? 0,
						requireRunning: ext.meta?.requireRunning ?? false,
						...ext.meta,
					}

					const cleanup = this.registry.register(ext.point, {
						meta,
						when: ext.when,
						render: (ctx) => {
							const Component = ext.Component
							return (
								<ExtensionErrorBoundary
									key={meta.id}
									pluginName={pluginName}
									extensionId={meta.id}
									point={ext.point}
								>
									<Component ctx={ctx} />
								</ExtensionErrorBoundary>
							)
						},
					})
					cleanups.push(cleanup)
				}
			}

			if (mod.routes) {
				for (const route of mod.routes) {
					const normalizedPath = normalizeExtensionRoutePath(route.definition.path)

					if (route.definition.addToNav) {
						const meta: ExtensionMeta = {
							id: `${pluginName}:route:${normalizedPath || '/'}`,
							pluginName,
							priority: route.definition.navPriority ?? 0,
							requireRunning: false,
							label: route.definition.title,
							href: buildExtensionHref(pluginName, normalizedPath),
							icon: route.definition.icon,
						}

						const cleanup = this.registry.register('navbar:items', {
							meta,
							render: () => null,
						})
						cleanups.push(cleanup)
					}

					this.registerRouteComponent(pluginName, normalizedPath, route.Component)
				}
			}

			this.loadedModules.set(pluginName, {
				module: mod,
				cleanups,
				loadedAt: Date.now(),
				sourceHash,
			})

			return true
		} catch (error) {
			console.error(`[Extension] Failed to load ${pluginName}:`, error)
			return false
		}
	}

	unloadPluginUI(pluginName: string): boolean {
		const loaded = this.loadedModules.get(pluginName)
		if (!loaded) return false

		loaded.cleanups.forEach((fn) => fn())
		this.unregisterRouteComponents(pluginName)
		this.loadedModules.delete(pluginName)
		return true
	}

	async syncWithManifest(
		bundles: CompiledExtensionBundle[],
		runningPlugins: Set<string>,
		options: SyncManifestOptions = {},
	): Promise<void> {
		const shouldForceReload = options.forceReload === true
		const changedPlugins = options.changedPlugins
		const bundleMap = new Map(bundles.map((b) => [b.pluginName, b]))

		for (const pluginName of this.loadedModules.keys()) {
			const bundle = bundleMap.get(pluginName)
			if (!bundle || !runningPlugins.has(pluginName)) {
				this.unloadPluginUI(pluginName)
			}
		}

		for (const bundle of bundles) {
			if (!runningPlugins.has(bundle.pluginName)) {
				continue
			}

			const existing = this.loadedModules.get(bundle.pluginName)
			const pluginChanged = changedPlugins?.has(bundle.pluginName) ?? false
			const forceThisPlugin = shouldForceReload || pluginChanged
			const needsReload =
				!existing || forceThisPlugin || existing.sourceHash !== bundle.sourceHash

			if (!needsReload) {
				continue
			}

			await this.loadPluginUI(bundle.pluginName, bundle.bundleUrl, bundle.sourceHash, {
				forceReload: forceThisPlugin && !!existing,
			})
		}
	}

	private registerRouteComponent(pluginName: string, path: string, component: RouteComponent): void {
		const key = buildExtensionRouteKey(pluginName, path)
		this.routeComponents.set(key, component)
	}

	private unregisterRouteComponents(pluginName: string): void {
		const prefix = buildExtensionRouteKey(pluginName, '')
		for (const key of this.routeComponents.keys()) {
			if (key.startsWith(prefix)) {
				this.routeComponents.delete(key)
			}
		}
	}
}

export const extensionRuntime = new ExtensionRuntime()

export const loadPluginUI = extensionRuntime.loadPluginUI.bind(extensionRuntime)
export const unloadPluginUI = extensionRuntime.unloadPluginUI.bind(extensionRuntime)
export const isPluginUILoaded = extensionRuntime.isPluginLoaded.bind(extensionRuntime)
export const getLoadedModules = extensionRuntime.getLoadedModules.bind(extensionRuntime)
export const getRouteComponent = extensionRuntime.getRouteComponent.bind(extensionRuntime)
export const getExtensionRoutes = extensionRuntime.getExtensionRoutes.bind(extensionRuntime)
export const syncWithManifest = extensionRuntime.syncWithManifest.bind(extensionRuntime)
