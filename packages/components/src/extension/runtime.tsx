import type { ReactNode } from 'react'
import { ExtensionErrorBoundary } from './ErrorBoundary'
import { unregisterPluginI18n, registerPluginI18n } from './i18n'
import { extensionRegistry } from './registry'
import type { ExtensionMeta, PluginExtensionContext, PluginUIModule } from './types'
import { extRuntime } from './debug'

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

const EXTENSION_ROUTE_PREFIX = '/ext/'

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

type RouteComponent = (ctx: PluginExtensionContext) => ReactNode

class ExtensionRuntime {
	private readonly pluginCleanups = new Map<string, Array<() => void>>()
	private readonly routeComponents = new Map<string, Map<string, RouteComponent>>()
	private readonly pluginHashes = new Map<string, string>()
	private readonly pluginVersions = new Map<string, number>()
	private revision = 0
	private readonly listeners = new Set<() => void>()
	private readonly pluginListeners = new Map<string, Set<() => void>>()

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getRevision(): number {
		return this.revision
	}

	getPluginRevision(pluginName: string): number {
		return this.pluginVersions.get(pluginName) ?? 0
	}

	private notify(): void {
		this.revision++
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				if (process.env.NODE_ENV !== 'production') {
					console.error('[ExtensionRuntime] listener failed', error)
				}
			}
		}
	}

	private notifyPlugin(pluginName: string): void {
		const next = (this.pluginVersions.get(pluginName) ?? 0) + 1
		this.pluginVersions.set(pluginName, next)
		const listeners = this.pluginListeners.get(pluginName)
		if (!listeners) return
		for (const listener of listeners) {
			try {
				listener()
			} catch (error) {
				if (process.env.NODE_ENV !== 'production') {
					console.error('[ExtensionRuntime] plugin listener failed', error)
				}
			}
		}
	}

	subscribePlugin(pluginName: string, listener: () => void): () => void {
		let bucket = this.pluginListeners.get(pluginName)
		if (!bucket) {
			bucket = new Set()
			this.pluginListeners.set(pluginName, bucket)
		}
		bucket.add(listener)
		return () => {
			const current = this.pluginListeners.get(pluginName)
			if (!current) return
			current.delete(listener)
			if (current.size === 0) {
				this.pluginListeners.delete(pluginName)
			}
		}
	}

	async loadPluginModule(
		pluginName: string,
		importer: () => Promise<PluginUIModule | { default?: PluginUIModule }>,
		sourceHash: string,
	): Promise<void> {
		const existingHash = this.pluginHashes.get(pluginName)
		if (existingHash === sourceHash) {
			return
		}

		extRuntime('loading runtime %s@%s', pluginName, sourceHash)
		this.disposePlugin(pluginName)

		const evaluated = await this.evaluateModule(importer)
		await this.registerPlugin(pluginName, evaluated)
		this.pluginHashes.set(pluginName, sourceHash)

		this.notify()
		this.notifyPlugin(pluginName)
		extRuntime('loaded runtime %s@%s', pluginName, sourceHash)
	}

	unloadPluginModule(pluginName: string): void {
		if (!this.pluginCleanups.has(pluginName)) return
		extRuntime('unload runtime %s', pluginName)
		this.disposePlugin(pluginName)
		this.notify()
		this.notifyPlugin(pluginName)
	}

	private disposePlugin(pluginName: string): void {
		const cleanups = this.pluginCleanups.get(pluginName)
		if (cleanups) {
			for (const cleanup of cleanups) {
				try {
					cleanup()
				} catch {}
			}
		}
		this.pluginCleanups.delete(pluginName)
		this.routeComponents.delete(pluginName)
		this.pluginHashes.delete(pluginName)
		unregisterPluginI18n(pluginName)
	}

	private async registerPlugin(pluginName: string, module: PluginUIModule): Promise<void> {
		const cleanups: Array<() => void> = []

		if (module.i18n) {
			registerPluginI18n(pluginName, module.i18n)
		}

		if (module.setup) {
			const maybe = await module.setup({ pluginName })
			if (typeof maybe === 'function') cleanups.push(maybe)
		}

		if (module.extensions) {
			for (const ext of module.extensions) {
				const extId = `${pluginName}:${ext.id}`
				const meta: ExtensionMeta = {
					...(ext.meta as any),
					id: extId,
					pluginName,
					priority: ext.priority ?? 0,
					// Default to hiding plugin-provided UI when the plugin is not running.
					// Plugins can opt out per extension via `requireRunning: false`.
					requireRunning: ext.requireRunning ?? true,
				}

				const cleanup = extensionRegistry.register(ext.point, {
					meta,
					render: (ctx) => {
						return (
							<ExtensionErrorBoundary
								key={meta.id}
								pluginName={pluginName}
								extensionId={meta.id}
								point={ext.point}
								fallback={
									process.env.NODE_ENV !== 'production'
										? ({ error }) => (
												<div
													style={{
														padding: 8,
														borderRadius: 8,
														border: '1px solid rgba(255, 0, 0, 0.25)',
														background: 'rgba(255, 0, 0, 0.06)',
														fontSize: 12,
														lineHeight: 1.4,
													}}
												>
													<div style={{ fontWeight: 600 }}>
														Extension render failed: {pluginName} · {ext.point}
													</div>
													<div style={{ opacity: 0.85 }}>
														{error?.message ?? String(error ?? 'unknown error')}
													</div>
												</div>
											)
										: null
								}
							>
								{ext.render(ctx as any)}
							</ExtensionErrorBoundary>
						)
					},
				})
				cleanups.push(cleanup)
			}
		}

		if (module.routes) {
			let routeMap = this.routeComponents.get(pluginName)
			if (!routeMap) {
				routeMap = new Map()
				this.routeComponents.set(pluginName, routeMap)
			} else {
				routeMap.clear()
			}

			for (const route of module.routes) {
				const normalizedPath = normalizeExtensionRoutePath(route.definition.path)
				routeMap.set(normalizedPath, route.render)

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

					const cleanup = extensionRegistry.register('navbar:items', {
						meta,
						render: () => null,
					})
					cleanups.push(cleanup)
				}
			}
		}

		this.pluginCleanups.set(pluginName, cleanups)
	}

	private async evaluateModule(
		importer: () => Promise<PluginUIModule | { default?: PluginUIModule }>,
	): Promise<PluginUIModule> {
		const loaded = await importer()
		if (loaded && typeof loaded === 'object' && 'default' in loaded && loaded.default) {
			return loaded.default as PluginUIModule
		}
		return loaded as PluginUIModule
	}

	getRouteComponent(pluginName: string, restPath: string): RouteComponent | undefined {
		const routeMap = this.routeComponents.get(pluginName)
		if (!routeMap) return undefined
		const normalized = normalizeExtensionRoutePath(restPath)
		return routeMap.get(normalized)
	}
}

export const extensionRuntime = new ExtensionRuntime()

export const loadExtensionModule = extensionRuntime.loadPluginModule.bind(extensionRuntime)
export const unloadExtensionModule = extensionRuntime.unloadPluginModule.bind(extensionRuntime)
export const subscribeExtensionRuntimeChanges = extensionRuntime.subscribe.bind(extensionRuntime)
export const getExtensionRuntimeRevision = extensionRuntime.getRevision.bind(extensionRuntime)
export const subscribePluginExtensionRuntimeChanges =
	extensionRuntime.subscribePlugin.bind(extensionRuntime)
export const getPluginExtensionRuntimeRevision =
	extensionRuntime.getPluginRevision.bind(extensionRuntime)
export const getPluginRouteComponent = extensionRuntime.getRouteComponent.bind(extensionRuntime)
