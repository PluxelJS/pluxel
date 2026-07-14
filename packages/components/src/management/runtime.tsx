import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
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
let catalogLoaded = false
let catalogInvalidation = -1
let catalogRequest: Promise<ManagementCatalog> | null = null
const loaded = new Map<string, string>()
const ownerLoads = new Map<string, { hash: string; promise: Promise<void> }>()
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
	let streamErrorReported = false
	stream.onOpen(() => {
		streamErrorReported = false
	})
	stream.onError(() => {
		if (streamErrorReported) return
		streamErrorReported = true
		console.error('[management-ui] layout revision stream disconnected; reconnecting')
	})
	stream.ns('management.layouts').on(() => {
		// This is an invalidation token, not the server revision. Reconnect snapshots
		// must also invalidate caches after a backend restart resets its revision.
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

function publishRoutes(target: string, routes: Map<string, () => ReactNode>): void {
	routeMaps.set(target, routes)
	notifyRoutes(target)
}

function notifyRoutes(target: string): void {
	routeRevisions.set(target, (routeRevisions.get(target) ?? 0) + 1)
	for (const listener of routeListeners.get(target) ?? []) {
		try {
			listener()
		} catch (error) {
			console.error(`[management-ui] route listener failed (${target})`, error)
		}
	}
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
			return () => {
				listeners?.delete(listener)
				if (listeners?.size === 0 && routeListeners.get(target) === listeners) {
					routeListeners.delete(target)
				}
			}
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
	minimumRevision = 0,
	invalidation = 0,
): Promise<ManagementCatalog> {
	if (isCatalogCurrent(minimumRevision, invalidation)) return catalog
	if (catalogRequest) {
		await catalogRequest
		if (isCatalogCurrent(minimumRevision, invalidation)) return catalog
	}
	const request = (async () => {
		const next = await load()
		if (!catalogLoaded || invalidation >= catalogInvalidation) publishCatalog(next, invalidation)
		return catalog
	})()
	catalogRequest = request
	try {
		return await request
	} finally {
		if (catalogRequest === request) catalogRequest = null
	}
}

function isCatalogCurrent(minimumRevision: number, invalidation: number): boolean {
	if (!catalogLoaded) return false
	if (catalogInvalidation > invalidation) return true
	return catalogInvalidation === invalidation && catalog.revision >= minimumRevision
}

function publishCatalog(next: ManagementCatalog, invalidation: number): void {
	catalog = next
	catalogLoaded = true
	catalogInvalidation = invalidation
	const retainedOwners = new Set([
		...next.modules.map((item) => item.pluginName),
		...next.states.map((item) => item.pluginName),
	])
	for (const owner of new Set([...loaded.keys(), ...routeMaps.keys()])) {
		if (retainedOwners.has(owner)) continue
		loaded.delete(owner)
		managementUiRegistry.unload(owner)
		if (routeMaps.delete(owner)) notifyRoutes(owner)
	}
	for (const listener of catalogListeners) {
		try {
			listener()
		} catch (error) {
			console.error('[management-ui] catalog listener failed', error)
		}
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
	catalogSnapshot: ManagementCatalog,
	locale: LocaleService,
): Promise<'loaded' | 'building'> {
	const artifact = catalogSnapshot.modules.find((item) => item.pluginName === owner)
	if (!artifact) {
		const artifactState = catalogSnapshot.states.find((item) => item.pluginName === owner)
		if (artifactState?.state === 'building') return 'building'
		if (artifactState?.state === 'error') {
			throw new Error(artifactState.message ?? `Management UI build failed: ${owner}`)
		}
		throw new Error(`Management UI artifact not found: ${owner}`)
	}
	if (loaded.get(owner) === artifact.sourceHash) return 'loaded'
	const pending = ownerLoads.get(owner)
	if (pending?.hash === artifact.sourceHash) {
		await pending.promise
		return 'loaded'
	}
	const previous = pending?.promise.catch((error) => {
		console.warn(`[management-ui] previous artifact load failed (${owner})`, error)
	})
	const task = (previous ?? Promise.resolve()).then(async () => {
		if (loaded.get(owner) === artifact.sourceHash) return undefined
		await loadManagementArtifact(artifact, locale)
		const currentArtifact = catalog.modules.find((item) => item.pluginName === owner)
		if (currentArtifact?.sourceHash !== artifact.sourceHash) {
			const retained = catalog.states.some((item) => item.pluginName === owner)
			if (!currentArtifact && !retained) managementUiRegistry.unload(owner)
			return undefined
		}
		loaded.set(owner, artifact.sourceHash)
		return undefined
	})
	ownerLoads.set(owner, { hash: artifact.sourceHash, promise: task })
	try {
		await task
	} finally {
		if (ownerLoads.get(owner)?.promise === task) ownerLoads.delete(owner)
	}
	return 'loaded'
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
			if (route.addToNav && layout.target === null) {
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
	// A target route table is an artifact/layout cache, not component-local state.
	// Keep it alive across route-screen unmounts and replace it atomically when a
	// newer target layout resolves. Removing it in this cleanup races SPA switches:
	// the route revision remains non-zero while the actual table has disappeared.
	if (layout.target) publishRoutes(layout.target, routes)
	return () => {
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
	const activeRegistration = useRef<{
		target: string | null
		cleanup: () => void
	} | null>(null)

	useEffect(
		() => () => {
			const active = activeRegistration.current
			activeRegistration.current = null
			if (active) extensionRegistry.batch(active.cleanup)
		},
		[],
	)

	useEffect(() => {
		let disposed = false
		const active = activeRegistration.current
		if (active && active.target !== target) {
			activeRegistration.current = null
			extensionRegistry.batch(active.cleanup)
		}
		const sync = async () => {
			try {
				const layout = target
					? await transport.http.management.pluginLayout(target)
					: await transport.http.management.globalLayout()
				const catalogSnapshot = await ensureCatalog(
					() => transport.http.management.catalog(),
					layout.revision,
					revision,
				)
				const owners = [
					...new Set(
						layout.items
							.filter(
								(item) =>
									item.view.kind === 'remote' &&
									(target !== null || item.placement !== 'plugin.routes'),
							)
							.map((item) => item.owner),
					),
				]
				const ownerResults = await Promise.allSettled(
					owners.map((owner) =>
						ensureOwnerLoaded(owner, catalogSnapshot, extensionContext.services.locale),
					),
				)
				if (disposed) return
				const failures = ownerResults.flatMap((result, index) =>
					result.status === 'rejected'
						? [{ owner: owners[index]!, error: toError(result.reason) }]
						: [],
				)
				const failedOwners = new Set(failures.map((failure) => failure.owner))
				const buildingOwners = new Set(
					ownerResults.flatMap((result, index) =>
						result.status === 'fulfilled' && result.value === 'building' ? [owners[index]!] : [],
					),
				)
				const resolvedLayout: ManagementLayout =
					failedOwners.size > 0 || buildingOwners.size > 0
						? {
								...layout,
								items: layout.items.filter(
									(item) =>
										item.view.kind !== 'remote' ||
										(!failedOwners.has(item.owner) && !buildingOwners.has(item.owner)),
								),
							}
						: layout
				const loadError =
					failures.length > 0
						? new Error(
								failures.map((failure) => `${failure.owner}: ${failure.error.message}`).join('\n'),
							)
						: null
				// An artifact build or load failure must not replace a working target
				// route table with a filtered empty layout. A later management revision
				// retries and atomically publishes the new table when it is ready.
				if (target !== null && (buildingOwners.size > 0 || failures.length > 0)) {
					setState({ layout: null, error: loadError })
					if (loadError) console.error('[management-ui] failed to load layout views', loadError)
					return
				}
				const nextCleanup = extensionRegistry.batch(() => {
					const cleanup = registerLayout(resolvedLayout)
					activeRegistration.current?.cleanup()
					return cleanup
				})
				activeRegistration.current = { target, cleanup: nextCleanup }
				setState({ layout: resolvedLayout, error: loadError })
				if (loadError) console.error('[management-ui] failed to load layout views', loadError)
			} catch (error) {
				if (!disposed) {
					const loadError = toError(error)
					setState({ layout: null, error: loadError })
					console.error('[management-ui] failed to resolve layout', loadError)
				}
			}
		}
		void sync()
		return () => {
			disposed = true
		}
	}, [extensionContext.services.locale, revision, target, transport])

	return state
}

export function ManagementLoader(): null {
	useResolvedManagementLayout(null)
	return null
}

export function PluginManagementLoader({ target }: { target: string }): ReactNode {
	const { error } = useResolvedManagementLayout(target)
	if (!error) return null
	return <InlineNotice title="Management UI 加载失败">{error.message}</InlineNotice>
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
