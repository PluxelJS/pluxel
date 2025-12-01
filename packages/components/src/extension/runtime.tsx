import type { ComponentType } from 'react'
import { ExtensionErrorBoundary } from './ErrorBoundary'
import { extensionRegistry } from './registry'
import type { AggregatedPluginModule, ExtensionMeta, PluginUIModule } from './types'

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

	async applyBundle(modules: AggregatedPluginModule[]): Promise<void> {
		for (const cleanups of this.pluginCleanups.values()) {
			for (const cleanup of cleanups) {
				try {
					cleanup()
				} catch {}
			}
		}
		this.pluginCleanups.clear()
		this.routeComponents.clear()

		for (const plugin of modules) {
			await this.registerPlugin(plugin)
		}

		this.notify()
	}

	private async registerPlugin(plugin: AggregatedPluginModule): Promise<void> {
		const evaluated = await this.evaluateModule(plugin.code)
		const mod = (evaluated.default ?? evaluated) as PluginUIModule
		const cleanups: Array<() => void> = []

		if (mod.setup) {
			await mod.setup()
		}

		if (mod.extensions) {
			for (const ext of mod.extensions) {
				const meta: ExtensionMeta = {
					id: `${plugin.pluginName}:${ext.point}:${Math.random().toString(36).slice(2)}`,
					pluginName: plugin.pluginName,
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
								pluginName={plugin.pluginName}
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
			let routeMap = this.routeComponents.get(plugin.pluginName)
			if (!routeMap) {
				routeMap = new Map()
				this.routeComponents.set(plugin.pluginName, routeMap)
			}

			for (const route of mod.routes) {
				const normalizedPath = normalizeExtensionRoutePath(route.definition.path)
				routeMap.set(normalizedPath, route.Component)

				if (route.definition.addToNav) {
					const meta: ExtensionMeta = {
						id: `${plugin.pluginName}:route:${normalizedPath || '/'}`,
						pluginName: plugin.pluginName,
						priority: route.definition.navPriority ?? 0,
						requireRunning: false,
						label: route.definition.title,
						href: buildExtensionHref(plugin.pluginName, normalizedPath),
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

		this.pluginCleanups.set(plugin.pluginName, cleanups)
	}

	private async evaluateModule(code: string): Promise<PluginUIModule> {
		const blob = new Blob([code], { type: 'application/javascript' })
		const url = URL.createObjectURL(blob)
		try {
			return (await import(/* @vite-ignore */ url)) as PluginUIModule
		} finally {
			URL.revokeObjectURL(url)
		}
	}

	getRouteComponent(pluginName: string, restPath: string): RouteComponent | undefined {
		const routeMap = this.routeComponents.get(pluginName)
		if (!routeMap) return undefined
		const normalized = normalizeExtensionRoutePath(restPath)
		return routeMap.get(normalized)
	}
}

export const extensionRuntime = new ExtensionRuntime()

export const applyExtensionBundle = extensionRuntime.applyBundle.bind(extensionRuntime)
export const subscribeExtensionRuntimeChanges = extensionRuntime.subscribe.bind(extensionRuntime)
export const getExtensionRuntimeRevision = extensionRuntime.getRevision.bind(extensionRuntime)
export const getPluginRouteComponent = extensionRuntime.getRouteComponent.bind(extensionRuntime)
