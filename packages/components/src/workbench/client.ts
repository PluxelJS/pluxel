import type {
	WorkbenchBundle,
	WorkbenchCatalog,
	WorkbenchLayout,
	WorkbenchLayoutItem,
	WorkbenchPlacement,
} from '@pluxel/runtime/workbench'
import type { WorkbenchLocaleService, WorkbenchUiModule } from '@pluxel/runtime/workbench/ui'
import type { RuntimeTransportClient } from '@pluxel/runtime/web'
import { loadFederatedWorkbenchModule } from './federationRuntime'
import {
	compileWorkbenchRoute,
	matchWorkbenchRoute,
	workbenchRoutesOverlap,
	type CompiledWorkbenchRoute,
} from './routes'
import { normalizeWorkbenchPath } from './paths'

export type WorkbenchTargetId = string | null
export type WorkbenchTargetState = 'loading' | 'ready' | 'error'

type ModuleRecord = {
	key: string
	owner: string
	hash: string
	module: WorkbenchUiModule
	cleanup?: () => void
	holds: number
	refs: number
}

export type WorkbenchModuleLoader = (
	artifact: WorkbenchBundle,
) => Promise<WorkbenchUiModule | { default?: WorkbenchUiModule }>

type RegisteredRoute = Readonly<{
	compiled: CompiledWorkbenchRoute
	frame: 'shell' | 'standalone'
	item: WorkbenchLayoutItem
}>

export type WorkbenchResolvedRoute = Readonly<{
	item: WorkbenchLayoutItem
	params: Readonly<Record<string, string>>
	frame: 'shell' | 'standalone'
}>

export type WorkbenchTargetSnapshot = Readonly<{
	target: WorkbenchTargetId
	state: WorkbenchTargetState
	revision: number
	layout: WorkbenchLayout | null
	error: Error | null
	surfaces: ReadonlyMap<WorkbenchPlacement, readonly WorkbenchLayoutItem[]>
	navigationRoutes: readonly WorkbenchLayoutItem[]
	routes: readonly RegisteredRoute[]
	modules: ReadonlyMap<string, ModuleRecord>
}>

type TargetEntry = {
	refs: number
	loadVersion: number
	loading: Promise<void> | null
	listeners: Set<() => void>
	snapshot: WorkbenchTargetSnapshot
}

const EMPTY_SURFACES = new Map<WorkbenchPlacement, readonly WorkbenchLayoutItem[]>()
const EMPTY_MODULES = new Map<string, ModuleRecord>()

function initialSnapshot(target: WorkbenchTargetId): WorkbenchTargetSnapshot {
	return Object.freeze({
		target,
		state: 'loading',
		revision: 0,
		layout: null,
		error: null,
		surfaces: EMPTY_SURFACES,
		navigationRoutes: Object.freeze([]),
		routes: Object.freeze([]),
		modules: EMPTY_MODULES,
	})
}

class WorkbenchModuleStore {
	private readonly records = new Map<string, ModuleRecord>()
	private readonly pending = new Map<string, Promise<ModuleRecord>>()

	constructor(
		private readonly locale: WorkbenchLocaleService,
		private readonly loadModule: WorkbenchModuleLoader,
	) {}

	async prepare(artifact: WorkbenchBundle): Promise<ModuleRecord> {
		const key = `${artifact.pluginName}:${artifact.sourceHash}`
		let record = this.records.get(key)
		if (!record) {
			let task = this.pending.get(key)
			if (!task) {
				task = this.load(key, artifact)
				this.pending.set(key, task)
			}
			try {
				record = await task
			} finally {
				if (this.pending.get(key) === task) this.pending.delete(key)
			}
		}
		record.holds += 1
		return record
	}

	promote(records: Iterable<ModuleRecord>): void {
		for (const record of records) {
			record.holds -= 1
			record.refs += 1
		}
	}

	releasePrepared(records: Iterable<ModuleRecord>): void {
		for (const record of records) {
			record.holds -= 1
			this.collect(record)
		}
	}

	releaseActive(records: Iterable<ModuleRecord>): void {
		for (const record of records) {
			record.refs -= 1
			this.collect(record)
		}
	}

	dispose(): void {
		for (const record of this.records.values()) this.cleanup(record)
		this.records.clear()
		this.pending.clear()
	}

	private async load(key: string, artifact: WorkbenchBundle): Promise<ModuleRecord> {
		const imported = await this.loadModule(artifact)
		const module =
			imported && typeof imported === 'object' && 'default' in imported && imported.default
				? imported.default
				: (imported as WorkbenchUiModule)
		if (
			!module ||
			typeof module !== 'object' ||
			!module.views ||
			typeof module.contractFingerprint !== 'string'
		) {
			throw new Error(`[workbench-ui] invalid UI module for ${artifact.pluginName}`)
		}
		const cleanup = module.setup
			? await module.setup({ ownerPluginId: artifact.pluginName, locale: this.locale })
			: undefined
		const record: ModuleRecord = {
			key,
			owner: artifact.pluginName,
			hash: artifact.sourceHash,
			module,
			cleanup: typeof cleanup === 'function' ? cleanup : undefined,
			holds: 0,
			refs: 0,
		}
		this.records.set(key, record)
		return record
	}

	private collect(record: ModuleRecord): void {
		if (record.holds > 0 || record.refs > 0) return
		if (this.records.get(record.key) !== record) return
		this.records.delete(record.key)
		this.cleanup(record)
	}

	private cleanup(record: ModuleRecord): void {
		try {
			record.cleanup?.()
		} catch (error) {
			console.error(`[workbench-ui] remote cleanup failed (${record.owner})`, error)
		}
	}
}

/**
 * Browser-owned Workbench runtime. It is the sole owner of catalog invalidation,
 * remote module revisions, target layouts, routes, and contribution snapshots.
 */
export class WorkbenchClientRuntime {
	private readonly modules: WorkbenchModuleStore
	private readonly targets = new Map<string, TargetEntry>()
	private catalog: WorkbenchCatalog = { revision: 0, bundles: [], states: [] }
	private catalogLoaded = false
	private catalogInvalidation = -1
	private catalogRequest: Promise<WorkbenchCatalog> | null = null
	private invalidation = 0
	private disposed = false
	private stream: ReturnType<RuntimeTransportClient['createSse']> | null = null

	constructor(
		private readonly transport: RuntimeTransportClient,
		locale: WorkbenchLocaleService,
		loadModule: WorkbenchModuleLoader = loadFederatedWorkbenchModule,
	) {
		this.modules = new WorkbenchModuleStore(locale, loadModule)
	}

	private startStream(): void {
		if (this.stream || this.disposed) return
		const stream = this.transport.createSse({
			url: this.transport.links.workbenchEvents(),
			namespaces: ['workbench.layouts'],
		})
		this.stream = stream
		let reported = false
		stream.onOpen(() => {
			reported = false
		})
		stream.onError(() => {
			if (reported) return
			reported = true
			console.warn('[workbench-ui] layout revision stream disconnected; reconnecting')
		})
		stream.ns('workbench.layouts').on(() => this.invalidate())
	}

	retain(target: WorkbenchTargetId): () => void {
		const entry = this.entry(target)
		entry.refs += 1
		if (entry.refs === 1) {
			this.startStream()
			void this.loadTarget(target, entry)
		}
		let active = true
		return () => {
			if (!active) return
			active = false
			entry.refs -= 1
			if (entry.refs > 0) return
			entry.loadVersion += 1
			this.targets.delete(targetKey(target))
			this.modules.releaseActive(entry.snapshot.modules.values())
			if ([...this.targets.values()].every((candidate) => candidate.refs === 0)) {
				this.stream?.close()
				this.stream = null
			}
		}
	}

	subscribe(target: WorkbenchTargetId, listener: () => void): () => void {
		const entry = this.entry(target)
		entry.listeners.add(listener)
		return () => entry.listeners.delete(listener)
	}

	getSnapshot(target: WorkbenchTargetId): WorkbenchTargetSnapshot {
		return this.entry(target).snapshot
	}

	resolveRoute(target: string, path: string): WorkbenchResolvedRoute | undefined {
		const snapshot = this.getSnapshot(target)
		const normalized = normalizeWorkbenchPath(path)
		const exact = snapshot.routes.find(
			(route) =>
				route.compiled.path === normalized &&
				route.compiled.segments.every((segment) => segment.parameter === undefined),
		)
		if (exact) return { item: exact.item, params: Object.freeze({}), frame: exact.frame }
		for (const route of snapshot.routes) {
			if (route.compiled.segments.every((segment) => segment.parameter === undefined)) continue
			const params = matchWorkbenchRoute(route.compiled, normalized)
			if (params) return { item: route.item, params, frame: route.frame }
		}
		return undefined
	}

	view(target: WorkbenchTargetId, item: WorkbenchLayoutItem) {
		const record = this.getSnapshot(target).modules.get(item.ownerPluginId)
		if (!record || record.module.contractFingerprint !== item.contractFingerprint) return undefined
		return record.module.views[item.view.kind === 'remote' ? item.view.export : '']
	}

	artifactState(owner: string) {
		return this.catalog.states.find((state) => state.pluginName === owner)
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.stream?.close()
		this.stream = null
		for (const entry of this.targets.values()) {
			this.modules.releaseActive(entry.snapshot.modules.values())
		}
		this.targets.clear()
		this.modules.dispose()
	}

	private invalidate(): void {
		if (this.disposed) return
		this.invalidation += 1
		for (const entry of this.targets.values()) {
			if (entry.refs > 0) void this.loadTarget(entry.snapshot.target, entry)
		}
	}

	private entry(target: WorkbenchTargetId): TargetEntry {
		const key = targetKey(target)
		let entry = this.targets.get(key)
		if (!entry) {
			entry = {
				refs: 0,
				loadVersion: 0,
				loading: null,
				listeners: new Set(),
				snapshot: initialSnapshot(target),
			}
			this.targets.set(key, entry)
		}
		return entry
	}

	private async loadTarget(target: WorkbenchTargetId, entry: TargetEntry): Promise<void> {
		if (this.disposed || entry.refs === 0) return
		const version = ++entry.loadVersion
		const invalidation = this.invalidation
		if (!entry.snapshot.layout) {
			entry.snapshot = Object.freeze({ ...entry.snapshot, state: 'loading', error: null })
			this.notify(entry)
		}
		const task = this.resolveTarget(target, invalidation)
		const loading = task
			.then(
				(next): void => {
					if (this.disposed || entry.refs === 0 || entry.loadVersion !== version) {
						this.modules.releasePrepared(next.modules.values())
						return
					}
					this.modules.promote(next.modules.values())
					const previous = entry.snapshot
					entry.snapshot = next
					this.modules.releaseActive(previous.modules.values())
					this.notify(entry)
					return undefined
				},
				(error: unknown): void => {
					if (this.disposed || entry.refs === 0 || entry.loadVersion !== version) return
					const cause = toError(error)
					entry.snapshot = Object.freeze({
						...entry.snapshot,
						state: entry.snapshot.layout ? 'ready' : 'error',
						error: cause,
					})
					this.notify(entry)
					return undefined
				},
			)
			.finally(() => {
				if (entry.loading === loading) entry.loading = null
				if (!this.disposed && entry.refs > 0 && this.invalidation !== invalidation) {
					void this.loadTarget(target, entry)
				}
			})
		entry.loading = loading
		await loading
	}

	private async resolveTarget(
		target: WorkbenchTargetId,
		invalidation: number,
	): Promise<WorkbenchTargetSnapshot> {
		const layout = target
			? await this.transport.http.workbench.pluginLayout(target)
			: await this.transport.http.workbench.globalLayout()
		const catalog = await this.ensureCatalog(layout.revision, invalidation)
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
		const staged = new Map<string, ModuleRecord>()
		try {
			for (const owner of owners) {
				const artifact = catalog.bundles.find((item) => item.pluginName === owner)
				if (!artifact) {
					const state = catalog.states.find((item) => item.pluginName === owner)
					if (state?.state === 'building') throw new Error(`Workbench UI is building: ${owner}`)
					throw new Error(state?.message ?? `Workbench UI artifact not found: ${owner}`)
				}
				staged.set(owner, await this.modules.prepare(artifact))
			}
			return compileSnapshot(target, layout, staged)
		} catch (error) {
			this.modules.releasePrepared(staged.values())
			throw error
		}
	}

	private async ensureCatalog(
		minimumRevision: number,
		invalidation: number,
	): Promise<WorkbenchCatalog> {
		if (this.catalogCurrent(minimumRevision, invalidation)) return this.catalog
		if (this.catalogRequest) {
			await this.catalogRequest
			if (this.catalogCurrent(minimumRevision, invalidation)) return this.catalog
		}
		const request = this.transport.http.workbench.catalog().then((catalog) => {
			if (!this.catalogLoaded || invalidation >= this.catalogInvalidation) {
				this.catalog = catalog
				this.catalogLoaded = true
				this.catalogInvalidation = invalidation
			}
			return this.catalog
		})
		this.catalogRequest = request
		try {
			return await request
		} finally {
			if (this.catalogRequest === request) this.catalogRequest = null
		}
	}

	private catalogCurrent(minimumRevision: number, invalidation: number): boolean {
		if (!this.catalogLoaded) return false
		if (this.catalogInvalidation > invalidation) return true
		return this.catalogInvalidation === invalidation && this.catalog.revision >= minimumRevision
	}

	private notify(entry: TargetEntry): void {
		for (const listener of entry.listeners) listener()
	}
}

function compileSnapshot(
	target: WorkbenchTargetId,
	layout: WorkbenchLayout,
	modules: ReadonlyMap<string, ModuleRecord>,
): WorkbenchTargetSnapshot {
	const surfaces = new Map<WorkbenchPlacement, WorkbenchLayoutItem[]>()
	const navigationRoutes: WorkbenchLayoutItem[] = []
	const routes: RegisteredRoute[] = []
	for (const item of layout.items) {
		if (target !== null && item.view.kind === 'remote') {
			validateRemoteView(item, modules)
		}
		if (item.placement === 'plugin.routes') {
			if (target === null) {
				if (item.meta?.route?.addToNav) navigationRoutes.push(item)
				continue
			}
			if (!item.meta?.route || item.view.kind !== 'remote') continue
			const compiled = compileWorkbenchRoute(item.meta.route.path)
			const conflict = routes.find(
				(candidate) =>
					candidate.compiled.segments.some((segment) => segment.parameter !== undefined) &&
					compiled.segments.some((segment) => segment.parameter !== undefined) &&
					workbenchRoutesOverlap(candidate.compiled, compiled),
			)
			if (conflict) {
				throw new Error(
					`[workbench-ui] ambiguous route patterns: ${conflict.compiled.path} and ${compiled.path}`,
				)
			}
			routes.push({ compiled, frame: item.meta.route.frame ?? 'shell', item })
			continue
		}
		let bucket = surfaces.get(item.placement)
		if (!bucket) {
			bucket = []
			surfaces.set(item.placement, bucket)
		}
		bucket.push(item)
	}
	routes.sort((left, right) => right.compiled.staticSegments - left.compiled.staticSegments)
	return Object.freeze({
		target,
		state: 'ready',
		revision: layout.revision,
		layout,
		error: null,
		surfaces,
		navigationRoutes: Object.freeze(navigationRoutes),
		routes: Object.freeze(routes),
		modules: new Map(modules),
	})
}

function validateRemoteView(
	item: WorkbenchLayoutItem,
	modules: ReadonlyMap<string, ModuleRecord>,
): void {
	const record = modules.get(item.ownerPluginId)
	if (!record) {
		throw new Error(`[workbench-ui] UI module not found for ${item.ownerPluginId}`)
	}
	if (record.module.contractFingerprint !== item.contractFingerprint) {
		throw new Error(`[workbench-ui] Contract mismatch for ${item.ownerPluginId}`)
	}
	if (
		typeof record.module.views[item.view.kind === 'remote' ? item.view.export : ''] !== 'function'
	) {
		throw new TypeError(
			`[workbench-ui] View export not found: ${item.ownerPluginId}:${
				item.view.kind === 'remote' ? item.view.export : item.viewId
			}`,
		)
	}
}

function targetKey(target: WorkbenchTargetId): string {
	return target === null ? '$global' : `plugin:${target}`
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error ?? 'Unknown Workbench error'))
}
