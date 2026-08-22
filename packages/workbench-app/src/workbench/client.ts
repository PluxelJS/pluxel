import type {
	WorkbenchCatalog,
	WorkbenchLayoutItem,
	WorkbenchPluginDescriptor,
} from '@pluxel/runtime/workbench'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLocaleService } from '@pluxel/runtime/workbench/ui'
import type { RuntimeTransportClient } from '@pluxel/runtime/web'
import { stringifyUnknown } from '../utils/unknown'
import { loadFederatedWorkbenchModule } from './federationRuntime'
import { matchWorkbenchRoute } from './routes'
import { normalizeWorkbenchPath } from './paths'
import {
	WorkbenchModuleStore,
	type WorkbenchModuleLoader,
	type WorkbenchModuleRecord,
} from './client-module-store'
import {
	compileWorkbenchSnapshot,
	createInitialWorkbenchSnapshot,
	type WorkbenchResolvedRoute,
	type WorkbenchTargetId,
	type WorkbenchTargetSnapshot,
} from './client-snapshot'

export type { WorkbenchModuleLoader } from './client-module-store'
export type {
	WorkbenchResolvedRoute,
	WorkbenchTargetId,
	WorkbenchTargetSnapshot,
	WorkbenchTargetState,
} from './client-snapshot'

type TargetEntry = {
	refs: number
	loadVersion: number
	resolvedInvalidation: number
	releaseVersion: number
	loading: Promise<void> | null
	listeners: Set<() => void>
	snapshot: WorkbenchTargetSnapshot
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
	private stream: ReturnType<RuntimeTransportClient['createSse']> | null = null

	constructor(
		private readonly transport: RuntimeTransportClient,
		locale: WorkbenchLocaleService,
		loadModule: WorkbenchModuleLoader = loadFederatedWorkbenchModule,
	) {
		this.modules = new WorkbenchModuleStore(locale, loadModule)
	}

	private startStream(): void {
		if (this.stream) return
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
		entry.releaseVersion += 1
		if (entry.refs === 1) {
			this.startStream()
			if (entry.loading === null && entry.resolvedInvalidation !== this.invalidation) {
				void this.loadTarget(target, entry)
			}
		}
		let active = true
		return () => {
			if (!active) return
			active = false
			entry.refs -= 1
			if (entry.refs > 0) return
			const releaseVersion = ++entry.releaseVersion
			queueMicrotask(() => this.collectReleasedTarget(target, entry, releaseVersion))
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

	resolveRoute(target: PluginNodeAddress, path: string): WorkbenchResolvedRoute | undefined {
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
		const record = this.getSnapshot(target).modules.get(pluginNodeIndexKey(item.owner.address))
		if (!record || record.module.contractFingerprint !== item.contractFingerprint) return undefined
		return record.module.views[item.view.kind === 'remote' ? item.view.export : '']
	}

	artifactState(owner: PluginNodeAddress) {
		const key = pluginNodeIndexKey(owner)
		return this.catalog.states.find((state) => pluginNodeIndexKey(state.owner.address) === key)
	}

	private invalidate(): void {
		this.invalidation += 1
		for (const entry of this.targets.values()) {
			if (entry.refs > 0 && entry.loading === null) {
				void this.loadTarget(entry.snapshot.target, entry)
			}
		}
	}

	private collectReleasedTarget(
		target: WorkbenchTargetId,
		entry: TargetEntry,
		releaseVersion: number,
	): void {
		if (entry.refs > 0 || entry.releaseVersion !== releaseVersion) return
		const key = targetKey(target)
		if (this.targets.get(key) !== entry) return
		entry.loadVersion += 1
		this.targets.delete(key)
		this.modules.releaseActive(entry.snapshot.modules.values())
		if ([...this.targets.values()].every((candidate) => candidate.refs === 0)) {
			this.stream?.close()
			this.stream = null
		}
	}

	private entry(target: WorkbenchTargetId): TargetEntry {
		const key = targetKey(target)
		let entry = this.targets.get(key)
		if (!entry) {
			entry = {
				refs: 0,
				loadVersion: 0,
				resolvedInvalidation: -1,
				releaseVersion: 0,
				loading: null,
				listeners: new Set(),
				snapshot: createInitialWorkbenchSnapshot(target),
			}
			this.targets.set(key, entry)
		}
		return entry
	}

	private async loadTarget(target: WorkbenchTargetId, entry: TargetEntry): Promise<void> {
		if (entry.refs === 0) return
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
					if (entry.refs === 0 || entry.loadVersion !== version) {
						this.modules.releasePrepared(next.modules.values())
						return
					}
					this.modules.promote(next.modules.values())
					const previous = entry.snapshot
					entry.snapshot = next
					entry.resolvedInvalidation = invalidation
					this.modules.releaseActive(previous.modules.values())
					this.notify(entry)
					return undefined
				},
				(error: unknown): void => {
					if (entry.refs === 0 || entry.loadVersion !== version) return
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
				if (entry.refs > 0 && this.invalidation !== invalidation) {
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
		const owners = new Map<string, WorkbenchPluginDescriptor>()
		for (const item of layout.items) {
			if (item.view.kind !== 'remote' || (target === null && item.placement === 'plugin.routes')) {
				continue
			}
			owners.set(pluginNodeIndexKey(item.owner.address), item.owner)
		}
		const staged = new Map<string, WorkbenchModuleRecord>()
		try {
			for (const [ownerKey, owner] of owners) {
				const artifact = catalog.bundles.find(
					(item) => pluginNodeIndexKey(item.owner.address) === ownerKey,
				)
				if (!artifact) {
					const state = catalog.states.find(
						(item) => pluginNodeIndexKey(item.owner.address) === ownerKey,
					)
					if (state?.state === 'building') {
						throw new Error(`Workbench UI is building: ${owner.displayName}`)
					}
					throw new Error(state?.message ?? `Workbench UI artifact not found: ${owner.displayName}`)
				}
				staged.set(ownerKey, await this.modules.prepare(artifact))
			}
			return compileWorkbenchSnapshot(target, layout, staged)
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
		if (this.catalogRequest !== null) {
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

function targetKey(target: WorkbenchTargetId): string {
	return target === null ? '$global' : `plugin:${pluginNodeIndexKey(target)}`
}

function toError(error: unknown): Error {
	return error instanceof Error
		? error
		: new Error(stringifyUnknown(error, 'Unknown Workbench error'))
}
