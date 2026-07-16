import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
	WorkbenchCatalog,
	WorkbenchLayout,
	WorkbenchLayoutItem,
	WorkbenchPlacement,
	WorkbenchBundle,
} from '@pluxel/runtime/workbench'
import { WorkbenchViewProvider } from '@pluxel/runtime/workbench/ui/internal'
import {
	useGlobalExtensionContext,
	type ExtensionMeta,
	type ExtensionPoint,
	type LocaleService,
} from '@pluxel/runtime/web'
import { InlineNotice } from '../components'
import { BuiltinDoc } from '../extension/builtin/Doc'
import { ExtensionErrorBoundary } from '../extension/ErrorBoundary'
import { loadFederatedWorkbenchModule } from './federationRuntime'
import { extensionRegistry } from '../extension/internal/registry'
import { buildExtensionHref, normalizeExtensionRouteSubPath } from '../extension/paths'
import { useRuntimeTransportClient } from '../runtime'
import { workbenchUiRegistry } from './internal/uiRegistry'

const placementMap: Partial<Record<WorkbenchPlacement, ExtensionPoint>> = {
	'global.headerActions': 'header:actions',
	'global.navbarItems': 'navbar:items',
	'global.navbarFooter': 'navbar:footer',
	'global.statusBar': 'global:statusBar',
	'plugin.header': 'plugin:header',
	'plugin.tabs': 'plugin:tabs',
	'plugin.actions': 'plugin:actions',
	'plugin.context': 'plugin:context',
	'plugin.info': 'plugin:info',
	'plugin.dock': 'plugin:dock',
	'plugin.capabilities': 'plugin:tabs',
}

let catalog: WorkbenchCatalog = { revision: 0, bundles: [], states: [] }
let catalogLoaded = false
let catalogInvalidation = -1
let catalogRequest: Promise<WorkbenchCatalog> | null = null
const loaded = new Map<string, string>()
const ownerLoads = new Map<string, { hash: string; promise: Promise<void> }>()
const catalogListeners = new Set<() => void>()
const routeMaps = new Map<string, Map<string, () => ReactNode>>()
const routeRevisions = new Map<string, number>()
const routeListeners = new Map<string, Set<() => void>>()
const revisionStores = new WeakMap<
	ReturnType<typeof useRuntimeTransportClient>,
	WorkbenchRevisionStore
>()

type WorkbenchRevisionStore = {
	getSnapshot(): number
	subscribe(listener: () => void): () => void
}

function workbenchRevisionStore(
	transport: ReturnType<typeof useRuntimeTransportClient>,
): WorkbenchRevisionStore {
	const existing = revisionStores.get(transport)
	if (existing) return existing
	let revision = 0
	const listeners = new Set<() => void>()
	const stream = transport.createSse({
		url: transport.links.workbenchEvents(),
		namespaces: ['workbench.layouts'],
	})
	let streamErrorReported = false
	stream.onOpen(() => {
		streamErrorReported = false
	})
	stream.onError(() => {
		if (streamErrorReported) return
		streamErrorReported = true
		console.warn('[workbench-ui] layout revision stream disconnected; reconnecting')
	})
	stream.ns('workbench.layouts').on(() => {
		// This is an invalidation token, not the server revision. Reconnect snapshots
		// must also invalidate caches after a backend restart resets its revision.
		revision += 1
		for (const listener of listeners) listener()
	})
	const store: WorkbenchRevisionStore = {
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
			console.error(`[workbench-ui] route listener failed (${target})`, error)
		}
	}
}

export function useWorkbenchRouteVersion(target: string): number {
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

export function getWorkbenchRoute(target: string, path: string): (() => ReactNode) | undefined {
	return routeMaps.get(target)?.get(normalizeExtensionRouteSubPath(path))
}

async function ensureCatalog(
	load: () => Promise<WorkbenchCatalog>,
	minimumRevision = 0,
	invalidation = 0,
): Promise<WorkbenchCatalog> {
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

function publishCatalog(next: WorkbenchCatalog, invalidation: number): void {
	catalog = next
	catalogLoaded = true
	catalogInvalidation = invalidation
	const retainedOwners = new Set([
		...next.bundles.map((item) => item.pluginName),
		...next.states.map((item) => item.pluginName),
	])
	for (const owner of new Set([...loaded.keys(), ...routeMaps.keys()])) {
		if (retainedOwners.has(owner)) continue
		loaded.delete(owner)
		workbenchUiRegistry.unload(owner)
		if (routeMaps.delete(owner)) notifyRoutes(owner)
	}
	for (const listener of catalogListeners) {
		try {
			listener()
		} catch (error) {
			console.error('[workbench-ui] catalog listener failed', error)
		}
	}
}

export function useWorkbenchArtifactState(owner: string) {
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
	catalogSnapshot: WorkbenchCatalog,
	locale: LocaleService,
): Promise<'loaded' | 'building'> {
	const artifact = catalogSnapshot.bundles.find((item) => item.pluginName === owner)
	if (!artifact) {
		const artifactState = catalogSnapshot.states.find((item) => item.pluginName === owner)
		if (artifactState?.state === 'building') return 'building'
		if (artifactState?.state === 'error') {
			throw new Error(artifactState.message ?? `Workbench UI build failed: ${owner}`)
		}
		throw new Error(`Workbench UI artifact not found: ${owner}`)
	}
	if (loaded.get(owner) === artifact.sourceHash) return 'loaded'
	const pending = ownerLoads.get(owner)
	if (pending?.hash === artifact.sourceHash) {
		await pending.promise
		return 'loaded'
	}
	const previous = pending?.promise.catch((error) => {
		console.warn(`[workbench-ui] previous artifact load failed (${owner})`, error)
	})
	const task: Promise<void> = (previous ?? Promise.resolve()).then(async (): Promise<void> => {
		if (loaded.get(owner) === artifact.sourceHash) return undefined
		await loadWorkbenchArtifact(artifact, locale)
		const currentArtifact = catalog.bundles.find((item) => item.pluginName === owner)
		if (currentArtifact?.sourceHash !== artifact.sourceHash) {
			const retained = catalog.states.some((item) => item.pluginName === owner)
			if (!currentArtifact && !retained) workbenchUiRegistry.unload(owner)
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

async function loadWorkbenchArtifact(
	artifact: WorkbenchBundle,
	locale: LocaleService,
): Promise<void> {
	await workbenchUiRegistry.load(
		artifact.pluginName,
		() =>
			loadFederatedWorkbenchModule({
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

function normalizeMeta(item: WorkbenchLayoutItem): ExtensionMeta {
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
		pluginName: item.targetPluginId,
		availabilityPluginName: item.ownerPluginId,
		priority: item.priority,
		requireRunning: item.when === 'running',
	}
}

function registerLayout(layout: WorkbenchLayout): () => void {
	const registrations: Array<{ point: ExtensionPoint; item: any }> = []
	const routes = new Map<string, () => ReactNode>()
	for (const item of layout.items) {
		if (item.placement === 'plugin.routes') {
			const route = item.meta?.route
			if (!route || item.view.kind !== 'remote') continue
			const path = normalizeExtensionRouteSubPath(route.path)
			routes.set(path, () => renderRemoteItem(item, `route:${path}`))
			if (route.addToNav && layout.targetPluginId === null) {
				registrations.push({
					point: 'navbar:items',
					item: {
						meta: {
							id: `${item.id}:nav`,
							pluginName: item.targetPluginId,
							availabilityPluginName: item.ownerPluginId,
							priority: route.navPriority ?? item.priority,
							requireRunning: false,
							label: route.title,
							href: buildExtensionHref(item.targetPluginId, path, route.frame ?? 'shell'),
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
	if (layout.targetPluginId) publishRoutes(layout.targetPluginId, routes)
	return () => {
		cleanupExtensions()
	}
}

function renderBuiltinItem(item: WorkbenchLayoutItem): ReactNode {
	if (item.view.kind !== 'builtin') return null
	const props = item.view.props as {
		title?: string
		description?: string
		content?: unknown
	}
	if (!Array.isArray(props.content)) {
		return <InlineNotice title="Invalid workbench document">content is required</InlineNotice>
	}
	return (
		<WorkbenchViewProvider item={item}>
			<BuiltinDoc
				id={item.id}
				pluginName={item.targetPluginId}
				title={props.title}
				description={props.description}
				content={props.content as any}
			/>
		</WorkbenchViewProvider>
	)
}

function renderRemoteItem(item: WorkbenchLayoutItem, point: string): ReactNode {
	if (item.view.kind !== 'remote') return null
	const loadedFingerprint = workbenchUiRegistry.contractFingerprint(item.ownerPluginId)
	if (loadedFingerprint !== item.contractFingerprint) {
		return (
			<InlineNotice title="Workbench Contract mismatch">
				{`expected ${item.contractFingerprint}, loaded ${loadedFingerprint ?? '<missing>'}`}
			</InlineNotice>
		)
	}
	const View = workbenchUiRegistry.view(item.ownerPluginId, item.view.export)
	if (!View) return <InlineNotice title="Workbench view not found">{item.view.export}</InlineNotice>
	return (
		<ExtensionErrorBoundary pluginName={item.ownerPluginId} extensionId={item.id} point={point}>
			<WorkbenchViewProvider item={item}>
				<View />
			</WorkbenchViewProvider>
		</ExtensionErrorBoundary>
	)
}

function useResolvedWorkbenchLayout(target: string | null) {
	const transport = useRuntimeTransportClient()
	const extensionContext = useGlobalExtensionContext()
	const revisionStore = workbenchRevisionStore(transport)
	const revision = useSyncExternalStore(
		revisionStore.subscribe,
		revisionStore.getSnapshot,
		revisionStore.getSnapshot,
	)
	const [state, setState] = useState<{
		layout: WorkbenchLayout | null
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
					? await transport.http.workbench.pluginLayout(target)
					: await transport.http.workbench.globalLayout()
				const catalogSnapshot = await ensureCatalog(
					() => transport.http.workbench.catalog(),
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
							.map((item) => item.ownerPluginId),
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
				const resolvedLayout: WorkbenchLayout =
					failedOwners.size > 0 || buildingOwners.size > 0
						? {
								...layout,
								items: layout.items.filter(
									(item) =>
										item.view.kind !== 'remote' ||
										(!failedOwners.has(item.ownerPluginId) &&
											!buildingOwners.has(item.ownerPluginId)),
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
				// route table with a filtered empty layout. A later workbench revision
				// retries and atomically publishes the new table when it is ready.
				if (target !== null && (buildingOwners.size > 0 || failures.length > 0)) {
					setState({ layout: null, error: loadError })
					if (loadError) console.error('[workbench-ui] failed to load layout views', loadError)
					return
				}
				const nextCleanup = extensionRegistry.batch(() => {
					const cleanup = registerLayout(resolvedLayout)
					activeRegistration.current?.cleanup()
					return cleanup
				})
				activeRegistration.current = { target, cleanup: nextCleanup }
				setState({ layout: resolvedLayout, error: loadError })
				if (loadError) console.error('[workbench-ui] failed to load layout views', loadError)
			} catch (error) {
				if (!disposed) {
					const loadError = toError(error)
					setState({ layout: null, error: loadError })
					console.error('[workbench-ui] failed to resolve layout', loadError)
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

export function WorkbenchLoader(): null {
	useResolvedWorkbenchLayout(null)
	return null
}

export function PluginWorkbenchLoader({ target }: { target: string }): ReactNode {
	const { error } = useResolvedWorkbenchLayout(target)
	if (!error) return null
	return <InlineNotice title="Workbench UI 加载失败">{error.message}</InlineNotice>
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
