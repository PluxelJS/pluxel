import type { ReactNode } from 'react'
import { extRuntime } from '../debug'
import { ExtensionErrorBoundary } from '../ErrorBoundary'
import { extensionLocale } from './locale'
import { extensionRegistry } from './registry'
import type {
	ExtensionItem,
	ExtensionMeta,
	ExtensionPoint,
	PluginExtensionContext,
	PluginUIModule,
} from '@pluxel/runtime/web/ui'
import { buildExtensionHref, normalizeExtensionRouteSubPath } from '../paths'

type RouteComponent = (ctx: PluginExtensionContext) => ReactNode
type RuntimeRegistration = { point: ExtensionPoint; item: ExtensionItem<any> }

interface PreparedPluginRuntime {
	setupCleanup?: () => void
	extensionRegistrations: RuntimeRegistration[]
	navRegistrations: RuntimeRegistration[]
	routeMap: Map<string, RouteComponent>
}

class PluginUiRegistry {
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
					console.error('[PluginUiRegistry] listener failed', error)
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
					console.error('[PluginUiRegistry] plugin listener failed', error)
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

		extRuntime('loading plugin-ui %s@%s', pluginName, sourceHash)
		const evaluated = await this.evaluateModule(importer)
		const prepared = await this.preparePlugin(pluginName, evaluated)
		this.commitPlugin(pluginName, prepared, sourceHash)

		this.notify()
		this.notifyPlugin(pluginName)
		extRuntime('loaded plugin-ui %s@%s', pluginName, sourceHash)
	}

	unloadPluginModule(pluginName: string): void {
		if (!this.pluginCleanups.has(pluginName)) return
		extRuntime('unload plugin-ui %s', pluginName)
		extensionRegistry.batch(() => {
			this.disposePlugin(pluginName)
		})
		this.notify()
		this.notifyPlugin(pluginName)
	}

	private disposePlugin(pluginName: string): void {
		const cleanups = this.pluginCleanups.get(pluginName)
		if (cleanups) {
			for (const cleanup of cleanups) {
				try {
					cleanup()
				} catch {
					// ignore cleanup errors
				}
			}
		}
		this.pluginCleanups.delete(pluginName)
		this.routeComponents.delete(pluginName)
		this.pluginHashes.delete(pluginName)
	}

	private async preparePlugin(
		pluginName: string,
		module: PluginUIModule,
	): Promise<PreparedPluginRuntime> {
		const prepared: PreparedPluginRuntime = {
			extensionRegistrations: [],
			navRegistrations: [],
			routeMap: new Map(),
		}

		try {
			if (module.setup) {
				const maybe = await module.setup({ pluginName, locale: extensionLocale })
				if (typeof maybe === 'function') {
					prepared.setupCleanup = maybe
				}
			}

			if (module.extensions) {
				for (const ext of module.extensions) {
					const extId = `${pluginName}:${ext.id}`
					const extRender = (ext as unknown as { render?: unknown })?.render
					const rawMeta = (ext as unknown as { meta?: unknown })?.meta
					const extraMeta =
						rawMeta && typeof rawMeta === 'object' ? (rawMeta as Record<string, unknown>) : {}
					const meta = {
						...extraMeta,
						id: extId,
						pluginName,
						priority: ext.priority ?? 0,
						// Default to hiding plugin-provided UI when the plugin is not running.
						// Plugins can opt out per extension via `requireRunning: false`.
						requireRunning: ext.requireRunning ?? true,
					} as ExtensionMeta

					prepared.extensionRegistrations.push({
						point: ext.point,
						item: {
							meta,
							render: (ctx) => {
								if (typeof extRender !== 'function') {
									return (
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
												Invalid extension: {pluginName} · {ext.point}
											</div>
											<div style={{ opacity: 0.85 }}>
												Expected <code>render(ctx)</code> to be a function.
											</div>
										</div>
									)
								}
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
										{(extRender as (ctx: unknown) => ReactNode)(ctx)}
									</ExtensionErrorBoundary>
								)
							},
						},
					})
				}
			}

			if (module.routes) {
				for (const route of module.routes) {
					const normalizedPath = normalizeExtensionRouteSubPath(route.definition.path)
					prepared.routeMap.set(normalizedPath, route.render)

					if (route.definition.addToNav) {
						const frame = route.definition.frame === 'standalone' ? 'standalone' : 'shell'
						const meta: ExtensionMeta<'navbar:items'> = {
							id: `${pluginName}:route:${normalizedPath || '/'}`,
							pluginName,
							priority: route.definition.navPriority ?? 0,
							requireRunning: false,
							label: route.definition.title,
							href: buildExtensionHref(pluginName, normalizedPath, frame),
							icon: route.definition.icon,
						}

						prepared.navRegistrations.push({
							point: 'navbar:items' satisfies ExtensionPoint,
							item: {
								meta,
								render: () => null,
							},
						})
					}
				}
			}

			return prepared
		} catch (error) {
			if (prepared.setupCleanup) {
				try {
					prepared.setupCleanup()
				} catch {
					// ignore cleanup errors
				}
			}
			throw error
		}
	}

	private commitPlugin(
		pluginName: string,
		prepared: PreparedPluginRuntime,
		sourceHash: string,
	): void {
		const cleanups: Array<() => void> = []
		if (prepared.setupCleanup) {
			cleanups.push(prepared.setupCleanup)
		}

		extensionRegistry.batch(() => {
			this.disposePlugin(pluginName)

			if (prepared.extensionRegistrations.length > 0) {
				cleanups.push(extensionRegistry.registerMany(prepared.extensionRegistrations))
			}
			if (prepared.navRegistrations.length > 0) {
				cleanups.push(extensionRegistry.registerMany(prepared.navRegistrations))
			}

			this.routeComponents.set(pluginName, new Map(prepared.routeMap))
			this.pluginCleanups.set(pluginName, cleanups)
			this.pluginHashes.set(pluginName, sourceHash)
		})
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
		const normalized = normalizeExtensionRouteSubPath(restPath)
		return routeMap.get(normalized)
	}
}

export const pluginUiRegistry = new PluginUiRegistry()

export const loadPluginUiModule = pluginUiRegistry.loadPluginModule.bind(pluginUiRegistry)
export const unloadPluginUiModule = pluginUiRegistry.unloadPluginModule.bind(pluginUiRegistry)
export const subscribePluginUiRegistryChanges =
	pluginUiRegistry.subscribe.bind(pluginUiRegistry)
export const getPluginUiRegistryRevision =
	pluginUiRegistry.getRevision.bind(pluginUiRegistry)
export const subscribePluginUiModuleChanges =
	pluginUiRegistry.subscribePlugin.bind(pluginUiRegistry)
export const getPluginUiModuleRevision =
	pluginUiRegistry.getPluginRevision.bind(pluginUiRegistry)
export const getPluginUiRouteComponent =
	pluginUiRegistry.getRouteComponent.bind(pluginUiRegistry)
