import {
	getPluginDefinitionFacts,
	getPluginInfo,
	pluginNodeAddressOf,
	type Context,
	type PluginConfigDefinition,
	type PluginConstructor,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import {
	isPluginEnabled,
	runtimeModuleRuntime,
	unknownPluginSource,
	type RuntimePluginDependencyInfo,
	type RuntimePluginStatusOverview,
} from '@pluxel/runtime/internal'
import type { ModuleReplacer, ReplaceModuleResult } from './module-replacer'
import type { PluginRegistry, PluginRegistryTransaction } from './PluginRegistry'

export type RemovalScope = 'runtime' | 'persisted'
export type LoaderCatalogEntry = Readonly<{
	address: PluginNodeAddressSnapshot
	ctor: PluginConstructor
	displayName: string
	rootExportName: string
}>
export type LoaderSyncModulesOptions = {
	exclude?: Iterable<string>
	forceRegistrations?: boolean
}

export type LoaderBatch = {
	replaceModule(moduleId: string, mod: Record<string, unknown>): Promise<ReplaceModuleResult>
	removeModule(moduleId: string): ReplaceModuleResult
	getAffectedModules(): readonly string[]
	syncModules(
		moduleIds: Iterable<string>,
		options?: LoaderSyncModulesOptions,
	): Promise<readonly string[]>
	rollback(): void
	commit(): void
}

export class AnchorStore {
	private readonly anchors = new Set<string>()
	private readonly hmrAnchors = new Set<string>()
	private version = 0
	private snapshotVersion = -1
	private snapshotCache: ReadonlySet<string> = new Set<string>()

	has(id: string): boolean {
		return this.anchors.has(id)
	}

	values(): IterableIterator<string> {
		return this.anchors.values()
	}

	snapshot(): ReadonlySet<string> {
		if (this.snapshotVersion === this.version) return this.snapshotCache
		this.snapshotCache = new Set(this.hmrAnchors)
		this.snapshotVersion = this.version
		return this.snapshotCache
	}

	add(id: string): void {
		if (this.anchors.has(id)) return
		this.anchors.add(id)
		if (!id.includes('/node_modules/')) this.hmrAnchors.add(id)
		this.version++
	}

	delete(id: string): void {
		if (!this.anchors.delete(id)) return
		this.hmrAnchors.delete(id)
		this.version++
	}
}

export class AnchorJournal {
	private readonly snapshot = new Map<string, boolean>()

	constructor(private readonly anchors: AnchorStore) {}

	record(id: string): void {
		if (!this.snapshot.has(id)) this.snapshot.set(id, this.anchors.has(id))
	}

	update(id: string, isAnchor: boolean): void {
		if (isAnchor) this.anchors.add(id)
		else this.anchors.delete(id)
	}

	rollback(): void {
		for (const [id, had] of this.snapshot) {
			if (had) this.anchors.add(id)
			else this.anchors.delete(id)
		}
	}

	commit(): void {
		this.snapshot.clear()
	}
}

export class LoaderBatchSession implements LoaderBatch {
	private readonly anchors: AnchorJournal
	private readonly affectedModules = new Set<string>()
	private closed = false

	constructor(
		private readonly moduleReplacer: ModuleReplacer,
		private readonly tx: PluginRegistryTransaction,
		anchors: AnchorStore,
		private readonly syncRuntimeForModules: (
			moduleIds: Iterable<string>,
			options?: LoaderSyncModulesOptions,
		) => Promise<readonly string[]>,
	) {
		this.anchors = new AnchorJournal(anchors)
	}

	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
	): Promise<ReplaceModuleResult> {
		this.assertOpen()
		const result = await this.moduleReplacer.replaceModule(moduleId, mod, {
			tx: this.tx,
			anchors: this.anchors,
		})
		for (const affected of result.affectedModules) this.affectedModules.add(affected)
		return result
	}

	removeModule(moduleId: string): ReplaceModuleResult {
		this.assertOpen()
		const result = this.moduleReplacer.removeModule(moduleId, {
			tx: this.tx,
			anchors: this.anchors,
		})
		for (const affected of result.affectedModules) this.affectedModules.add(affected)
		return result
	}

	getAffectedModules(): readonly string[] {
		return [...this.affectedModules]
	}

	async syncModules(
		moduleIds: Iterable<string>,
		options?: LoaderSyncModulesOptions,
	): Promise<readonly string[]> {
		this.assertOpen()
		return await this.syncRuntimeForModules(moduleIds, options)
	}

	rollback(): void {
		if (this.closed) return
		this.closed = true
		this.tx.rollback()
		this.anchors.rollback()
	}

	commit(): void {
		if (this.closed) return
		this.closed = true
		this.tx.commit()
		this.anchors.commit()
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('LoaderBatch is already closed')
	}
}

export class RuntimeResolver {
	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
	) {}

	resolve(address: PluginNodeAddressSnapshot): PluginConstructor | undefined {
		return this.registry.resolve(address)
	}

	resolveDefinition(address: PluginDefinitionAddressSnapshot): PluginConstructor | undefined {
		return this.registry.resolveDefinition(address)
	}

	isRunning(address: PluginNodeAddressSnapshot): boolean {
		return this.ctx.registry.isRunning(this.ctx.registry.internNodeAddress(address))
	}

	normalizeId(moduleId: string): string {
		return runtimeModuleRuntime(this.ctx).normalizeId(moduleId)
	}
}

export class PluginStatusReporter {
	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
		private readonly runtime: RuntimeResolver,
	) {}

	snapshot(): RuntimePluginStatusOverview {
		const statuses = this.registry.listRegistered().map((item) => {
			const isRunning = this.runtime.isRunning(item.address)
			const isEnabled = isPluginEnabled(this.ctx.runtimeState.snapshot(), item.address)
			return {
				address: item.address,
				displayName: item.displayName,
				rootExportName: item.rootExportName,
				isRunning,
				isEnabled,
				lifecycleStage: !isEnabled
					? ('disabled' as const)
					: isRunning
						? ('running' as const)
						: ('stopped' as const),
				source: unknownPluginSource(),
			}
		})
		let running = 0
		let disabled = 0
		for (const status of statuses) {
			if (status.isRunning) running++
			if (!status.isEnabled) disabled++
		}
		return {
			statuses,
			summary: {
				total: statuses.length,
				running,
				disabled,
				stopped: statuses.length - running - disabled,
			},
		}
	}
}

export class PluginDependencyInspector {
	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
	) {}

	list(address: PluginNodeAddressSnapshot): RuntimePluginDependencyInfo {
		const ctor = this.registry.require(address)
		const facts = getPluginDefinitionFacts(ctor)
		const node = this.ctx.registry.internNodeAddress(address)
		return facts.requires.flatMap((required, index) => {
			const resolved = this.ctx.registry.graph.depsOf(node)[index]
			const dependency =
				resolved && typeof resolved === 'object' && 'definition' in resolved
					? this.ctx.registry.nodeAddressOf(resolved as never)
					: ({ definition: required, instance: 'default' } as const)
			const provider = this.registry.resolve(dependency)
			return [
				{
					address: dependency,
					displayName: provider
						? getPluginInfo(provider).displayName
						: dependency.definition.exportName,
					isRunning: this.ctx.registry.isRunning(this.ctx.registry.internNodeAddress(dependency)),
				},
			]
		})
	}
}

export class PluginPruner {
	constructor(
		private readonly registry: PluginRegistry,
		private readonly anchors: AnchorStore,
	) {}

	pruneModule(moduleId: string, scope: RemovalScope = 'runtime'): void {
		if (scope === 'persisted') this.registry.disablePersistedByModule(moduleId)
		this.registry.stopModule(moduleId)
		this.registry.undeclareModule(moduleId)
		this.anchors.delete(moduleId)
	}
}

export class LoaderRegistryView {
	constructor(private readonly registry: PluginRegistry) {}

	listRegistered(): readonly LoaderCatalogEntry[] {
		return this.registry.listRegistered().map((item) => ({
			address: item.address,
			ctor: item.ctor,
			displayName: item.displayName,
			rootExportName: item.rootExportName,
		}))
	}

	findModuleId(address: PluginNodeAddressSnapshot): string | null {
		return this.registry.findModuleId(address)
	}

	getCtor(address: PluginNodeAddressSnapshot): PluginConstructor | undefined {
		return this.registry.resolve(address)
	}

	getExportKey(address: PluginNodeAddressSnapshot): string | undefined {
		return this.registry.getExportKey(address)
	}

	getConfig(address: PluginNodeAddressSnapshot): PluginConfigDefinition | undefined {
		return this.registry.getConfig(address)
	}
}

export class LoaderAnchors {
	constructor(private readonly anchors: AnchorStore) {}

	has(moduleId: string): boolean {
		return this.anchors.has(moduleId)
	}

	list(): IterableIterator<string> {
		return this.anchors.values()
	}

	snapshot(): ReadonlySet<string> {
		return this.anchors.snapshot()
	}

	remove(moduleId: string): void {
		this.anchors.delete(moduleId)
	}
}

export class LoaderControl {
	constructor(private readonly registry: PluginRegistry) {}

	enable(address: PluginNodeAddressSnapshot, ctor?: PluginConstructor): Promise<void> {
		return this.registry.enable(address, ctor)
	}

	enablePersisted(address: PluginNodeAddressSnapshot): void {
		this.registry.enablePersisted(address)
	}

	deactivate(
		address: PluginNodeAddressSnapshot,
		ctor: PluginConstructor,
		options: { runtimeOnly: boolean },
	): void {
		this.registry.deactivate(address, ctor, options)
	}

	stop(address: PluginNodeAddressSnapshot, ctor: PluginConstructor): void {
		this.registry.stopPlugin(address, ctor)
	}
}

export type LoaderApi = {
	runtime: RuntimeResolver
	status: PluginStatusReporter
	deps: PluginDependencyInspector
	registry: LoaderRegistryView
	anchors: LoaderAnchors
	control: LoaderControl
}

export function catalogEntryOf(ctor: PluginConstructor): LoaderCatalogEntry {
	const info = getPluginInfo(ctor)
	return {
		address: pluginNodeAddressOf(ctor),
		ctor,
		displayName: info.displayName,
		rootExportName: info.rootExportName,
	}
}
