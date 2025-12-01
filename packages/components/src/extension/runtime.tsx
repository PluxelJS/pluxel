import type { ComponentType } from 'react'
import { ExtensionErrorBoundary } from './ErrorBoundary'
import { extensionRegistry } from './registry'
import type { ExtensionMeta, PluginUIModule } from './types'

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

type RouteComponent = ComponentType

class ExtensionRuntime {
	private readonly pluginCleanups = new Map<string, Array<() => void>>()
	private readonly routeComponents = new Map<string, Map<string, RouteComponent>>()
	private readonly pluginHashes = new Map<string, string>()
	private revision = 0
	private readonly listeners = new Set<() => void>()

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getRevision(): number {
		return this.revision
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

	async loadPluginModule(
		pluginName: string,
		importer: () => Promise<PluginUIModule | { default?: PluginUIModule }>,
		sourceHash: string,
	): Promise<void> {
		const existingHash = this.pluginHashes.get(pluginName)
		if (existingHash === sourceHash) {
			return
		}

		this.disposePlugin(pluginName)

		const evaluated = await this.evaluateModule(importer)
		await this.registerPlugin(pluginName, evaluated)
		this.pluginHashes.set(pluginName, sourceHash)

		this.notify()
	}

	unloadPluginModule(pluginName: string): void {
		if (!this.pluginCleanups.has(pluginName)) return
		this.disposePlugin(pluginName)
		this.notify()
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
	}

	private async registerPlugin(pluginName: string, module: PluginUIModule): Promise<void> {
		const cleanups: Array<() => void> = []

		if (module.setup) {
			await module.setup()
		}

		if (module.extensions) {
			for (const ext of module.extensions) {
				const meta: ExtensionMeta = {
					id: `${pluginName}:${ext.point}:${Math.random().toString(36).slice(2)}`,
					pluginName,
					priority: ext.meta?.priority ?? 0,
					requireRunning: ext.meta?.requireRunning ?? false,
					...ext.meta,
				}

				const cleanup = extensionRegistry.register(ext.point, {
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
				routeMap.set(normalizedPath, route.Component)

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
export const getPluginRouteComponent = extensionRuntime.getRouteComponent.bind(extensionRuntime)
