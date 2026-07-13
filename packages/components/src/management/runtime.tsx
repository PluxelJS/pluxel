import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
	ManagementCatalog,
	ManagementLayout,
	ManagementLayoutItem,
	ManagementPlacement,
	ManagementUiArtifact,
} from '@pluxel/runtime/management'
import { ManagementViewProvider } from '@pluxel/runtime/management/ui'
import {
	useGlobalExtensionContext,
	type ExtensionMeta,
	type ExtensionPoint,
	type LocaleService,
} from '@pluxel/runtime/web'
import { InlineNotice } from '../components'
import { BuiltinDoc } from '../extension/builtin/Doc'
import { ExtensionErrorBoundary } from '../extension/ErrorBoundary'
import { loadFederatedManagementModule } from './federationRuntime'
import { extensionRegistry } from '../extension/internal/registry'
import { buildExtensionHref, normalizeExtensionRouteSubPath } from '../extension/paths'
import { useRuntimeTransportClient } from '../runtime'
import { managementUiRegistry } from './internal/uiRegistry'

const placementMap: Partial<Record<ManagementPlacement, ExtensionPoint>> = {
	'global.header-actions': 'header:actions',
	'global.navbar-items': 'navbar:items',
	'global.navbar-footer': 'navbar:footer',
	'global.status-bar': 'global:statusBar',
	'plugin.header': 'plugin:header',
	'plugin.tabs': 'plugin:tabs',
	'plugin.actions': 'plugin:actions',
	'plugin.context': 'plugin:context',
	'plugin.info': 'plugin:info',
	'plugin.dock': 'plugin:dock',
	'plugin.capabilities': 'plugin:tabs',
}

let catalog: ManagementCatalog = { revision: 0, modules: [], states: [] }
let catalogPromise: Promise<ManagementCatalog> | null = null
const loaded = new Map<string, string>()
const catalogListeners = new Set<() => void>()
const routeMaps = new Map<string, Map<string, () => ReactNode>>()
const routeRevisions = new Map<string, number>()
const routeListeners = new Map<string, Set<() => void>>()
const revisionStores = new WeakMap<
	ReturnType<typeof useRuntimeTransportClient>,
	ManagementRevisionStore
>()

type ManagementRevisionStore = {
	getSnapshot(): number
	subscribe(listener: () => void): () => void
}

function managementRevisionStore(
	transport: ReturnType<typeof useRuntimeTransportClient>,
): ManagementRevisionStore {
	const existing = revisionStores.get(transport)
	if (existing) return existing
	let revision = 0
	const listeners = new Set<() => void>()
	const stream = transport.createSse({
		url: transport.links.managementEvents(),
		namespaces: ['management.layouts'],
	})
	stream.ns('management.layouts').on(() => {
		revision += 1
		for (const listener of listeners) listener()
	})
	const store: ManagementRevisionStore = {
		getSnapshot: () => revision,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
	revisionStores.set(transport, store)
	return store
}

function publishRoutes(target: string, routes: Map<string, () => ReactNode>): () => void {
	routeMaps.set(target, routes)
	notifyRoutes(target)
	return () => {
		if (routeMaps.get(target) !== routes) return
		routeMaps.delete(target)
		notifyRoutes(target)
	}
}

function notifyRoutes(target: string): void {
	routeRevisions.set(target, (routeRevisions.get(target) ?? 0) + 1)
	for (const listener of routeListeners.get(target) ?? []) listener()
}

export function useManagementRouteVersion(target: string): number {
	return useSyncExternalStore(
		(listener) => {
			let listeners = routeListeners.get(target)
			if (!listeners) {
				listeners = new Set()
				routeListeners.set(target, listeners)
			}
			listeners.add(listener)
			return () => listeners?.delete(listener)
		},
		() => routeRevisions.get(target) ?? 0,
		() => routeRevisions.get(target) ?? 0,
	)
}

export function getManagementRoute(target: string, path: string): (() => ReactNode) | undefined {
	return routeMaps.get(target)?.get(normalizeExtensionRouteSubPath(path))
}

async function ensureCatalog(
	load: () => Promise<ManagementCatalog>,
	force = false,
): Promise<ManagementCatalog> {
	if (!force && catalog.modules.length > 0) return catalog
	if (!force && catalogPromise) return await catalogPromise
	catalogPromise = load().then((next) => {
		catalog = next
		for (const listener of catalogListeners) listener()
		return next
	})
	try {
		return await catalogPromise
	} finally {
		catalogPromise = null
	}
}

export function useManagementArtifactState(owner: string) {
	const snapshot = useSyncExternalStore(
		(listener) => {
			catalogListeners.add(listener)
			return () => catalogListeners.delete(listener)
		},
		() => catalog,
		() => catalog,
	)
	return snapshot.states.find((state) => state.pluginName === owner)
}

async function ensureOwnerLoaded(
	owner: string,
	loadCatalog: () => Promise<ManagementCatalog>,
	locale: LocaleService,
): Promise<void> {
	let current = await ensureCatalog(loadCatalog)
	let artifact = current.modules.find((item) => item.pluginName === owner)
	if (!artifact) {
		current = await ensureCatalog(loadCatalog, true)
		artifact = current.modules.find((item) => item.pluginName === owner)
	}
	if (!artifact) throw new Error(`Management UI artifact not found: ${owner}`)
	if (loaded.get(owner) === artifact.sourceHash) return
	await loadManagementArtifact(artifact, locale)
	loaded.set(owner, artifact.sourceHash)
}

async function loadManagementArtifact(
	artifact: ManagementUiArtifact,
	locale: LocaleService,
): Promise<void> {
	await managementUiRegistry.load(
		artifact.pluginName,
		() =>
			loadFederatedManagementModule({
				pluginName: artifact.pluginName,
				remoteName: artifact.remoteName,
				manifestUrl: artifact.manifestUrl,
				exposedModule: artifact.exposedModule,
				sourceHash: artifact.sourceHash,
				compiledAt: artifact.compiledAt,
			}),
		artifact.sourceHash,
		locale,
	)
}

function normalizeMeta(item: ManagementLayoutItem): ExtensionMeta {
	const capabilities = item.placement === 'plugin.capabilities'
	return {
		...item.meta,
		...(capabilities
			? {
					label: item.meta?.label ?? 'Capability',
					tab: { id: 'capabilities', label: 'Capabilities', icon: 'plug' },
				}
			: {}),
		id: item.id,
		pluginName: item.target,
		availabilityPluginName: item.owner,
		priority: item.priority,
		requireRunning: item.requireRunning,
	}
}

function registerLayout(layout: ManagementLayout): () => void {
	const registrations: Array<{ point: ExtensionPoint; item: any }> = []
	const routes = new Map<string, () => ReactNode>()
	for (const item of layout.items) {
		if (item.placement === 'plugin.routes') {
			const route = item.meta?.route
			if (!route || item.view.kind !== 'remote') continue
			const path = normalizeExtensionRouteSubPath(route.path)
			routes.set(path, () => renderRemoteItem(item, `route:${path}`))
			if (route.addToNav) {
				registrations.push({
					point: 'navbar:items',
					item: {
						meta: {
							id: `${item.id}:nav`,
							pluginName: item.target,
							availabilityPluginName: item.owner,
							priority: route.navPriority ?? item.priority,
							requireRunning: false,
							label: route.title,
							href: buildExtensionHref(item.target, path, route.frame ?? 'shell'),
							icon: route.icon,
						},
						render: (): ReactNode => null,
					},
				})
			}
			continue
		}
		const point = placementMap[item.placement]
		if (!point) continue
		const meta = normalizeMeta(item)
		registrations.push({
			point,
			item: {
				meta,
				render: () => {
					if (item.view.kind !== 'remote') return renderBuiltinItem(item)
					return renderRemoteItem(item, point)
				},
			},
		})
	}
	const cleanupExtensions = extensionRegistry.registerMany(registrations)
	const cleanupRoutes = layout.target ? publishRoutes(layout.target, routes) : () => {}
	return () => {
		cleanupRoutes()
		cleanupExtensions()
	}
}

function renderBuiltinItem(item: ManagementLayoutItem): ReactNode {
	if (item.view.kind !== 'builtin') return null
	if (item.view.renderer !== 'document') {
		return (
			<InlineNotice title="Builtin management renderer unavailable">
				{item.view.renderer}
			</InlineNotice>
		)
	}
	const props = item.view.props as {
		title?: string
		description?: string
		content?: unknown
	}
	if (!Array.isArray(props.content)) {
		return <InlineNotice title="Invalid management document">content is required</InlineNotice>
	}
	return (
		<ManagementViewProvider item={item}>
			<BuiltinDoc
				def={{
					kind: 'doc',
					point: placementMap[item.placement] ?? 'plugin:context',
					id: item.id,
					pluginName: item.target,
					title: props.title,
					description: props.description,
					content: props.content as any,
				}}
			/>
		</ManagementViewProvider>
	)
}

function renderRemoteItem(item: ManagementLayoutItem, point: string): ReactNode {
	if (item.view.kind !== 'remote') return null
	const View = managementUiRegistry.view(item.owner, item.view.export)
	if (!View)
		return <InlineNotice title="Management view not found">{item.view.export}</InlineNotice>
	return (
		<ExtensionErrorBoundary pluginName={item.owner} extensionId={item.id} point={point}>
			<ManagementViewProvider item={item}>
				<View />
			</ManagementViewProvider>
		</ExtensionErrorBoundary>
	)
}

function useResolvedManagementLayout(target: string | null) {
	const transport = useRuntimeTransportClient()
	const extensionContext = useGlobalExtensionContext()
	const revisionStore = managementRevisionStore(transport)
	const revision = useSyncExternalStore(
		revisionStore.subscribe,
		revisionStore.getSnapshot,
		revisionStore.getSnapshot,
	)
	const [state, setState] = useState<{
		layout: ManagementLayout | null
		error: Error | null
	}>({ layout: null, error: null })

	useEffect(() => {
		let disposed = false
		let unregister: (() => void) | undefined
		const sync = async () => {
			try {
				const layout = target
					? await transport.http.management.pluginLayout(target)
					: await transport.http.management.globalLayout()
				await ensureCatalog(() => transport.http.management.catalog(), revision > 0)
				await Promise.all(
					layout.items
						.filter((item) => item.view.kind === 'remote')
						.map((item) =>
							ensureOwnerLoaded(
								item.owner,
								() => transport.http.management.catalog(),
								extensionContext.services.locale,
							),
						),
				)
				if (disposed) return
				unregister?.()
				unregister = registerLayout(layout)
				setState({ layout, error: null })
			} catch (error) {
				if (!disposed) setState({ layout: null, error: toError(error) })
			}
		}
		void sync()
		return () => {
			disposed = true
			unregister?.()
		}
	}, [extensionContext.services.locale, revision, target, transport])

	return state
}

export function ManagementLoader(): null {
	useResolvedManagementLayout(null)
	return null
}

export function PluginManagementLoader({ target }: { target: string }): null {
	useResolvedManagementLayout(target)
	return null
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
