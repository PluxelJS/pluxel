import {
	type CommitSummary,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginConfigDefinition } from '@pluxel/core/internal'
import {
	pluginCatalogEntry,
	readRuntimePluginStatusOverview,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
	type PluginApplyReport,
	type PluginRouteCatalogSnapshot,
	type RuntimeStatePatch,
} from '@pluxel/runtime/internal'
import type { ModuleReplacer, ReplaceModuleResult } from './module-replacer'
import type { PluginCatalogDraft } from './PluginCatalogDraft'

export type LoaderCatalogEntry = Readonly<{
	address: PluginNodeAddress
	ctor: PluginConstructor
	displayName: string
	rootExportName: string
}>

export type LoaderBatchCommitOptions = Readonly<{
	/** @internal Activates prevalidated artifacts at the accepted graph boundary. */
	onGraphCommitted?: () => void
	reason?: string
	mode?: 'cold-boot' | 'live'
	statePatch?: RuntimeStatePatch
}>

export type LoaderBatch = {
	declarePlugin(moduleId: string, implementation: PluginConstructor): PluginNodeAddress
	replaceModule(moduleId: string, mod: Record<string, unknown>): Promise<ReplaceModuleResult>
	removeModule(moduleId: string): ReplaceModuleResult
	commit(options?: LoaderBatchCommitOptions): Promise<PluginApplyReport<CommitSummary>>
	rollback(): void
}

export class LoaderBatchSession implements LoaderBatch {
	private closed = false

	constructor(
		private readonly moduleReplacer: ModuleReplacer,
		private readonly draft: PluginCatalogDraft,
		private readonly ctx: Context,
	) {}

	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
	): Promise<ReplaceModuleResult> {
		this.assertOpen()
		return await this.moduleReplacer.replaceModule(this.draft, moduleId, mod)
	}

	declarePlugin(moduleId: string, implementation: PluginConstructor): PluginNodeAddress {
		this.assertOpen()
		return this.draft.declarePlugin(moduleId, implementation)
	}

	removeModule(moduleId: string): ReplaceModuleResult {
		this.assertOpen()
		return this.moduleReplacer.removeModule(this.draft, moduleId)
	}

	async commit(options: LoaderBatchCommitOptions = {}): Promise<PluginApplyReport<CommitSummary>> {
		this.assertOpen()
		const coordinator = requireRuntimePluginGraphCoordinator(this.ctx)
		const snapshot = this.draft.commitSnapshot()
		this.closed = true
		try {
			return await coordinator.update({
				catalog: snapshot,
				onGraphCommitted: options.onGraphCommitted,
				statePatch: options.statePatch,
				reason: options.reason ?? 'dynamic-catalog-update',
				mode: options.mode ?? (coordinator.catalogSnapshot().revision === 0 ? 'cold-boot' : 'live'),
			})
		} catch (error) {
			this.draft.rollback()
			throw error
		}
	}

	rollback(): void {
		if (this.closed) return
		this.closed = true
		this.draft.rollback()
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('LoaderBatch is already closed')
	}
}

export class PluginStatusReporter {
	constructor(private readonly ctx: Context) {}

	snapshot() {
		return readRuntimePluginStatusOverview(this.ctx)
	}
}

export class LoaderRegistryView {
	private cachedCatalog: PluginRouteCatalogSnapshot | undefined
	private cachedEntries: readonly LoaderCatalogEntry[] = Object.freeze([])

	constructor(private readonly ctx: Context) {}

	/** @internal One coordinator-owned immutable snapshot for route diagnostics. */
	catalogSnapshot(): PluginRouteCatalogSnapshot {
		return this.catalog()
	}

	listRegistered(): readonly LoaderCatalogEntry[] {
		const catalog = this.catalog()
		if (catalog === this.cachedCatalog) return this.cachedEntries
		this.cachedCatalog = catalog
		this.cachedEntries = Object.freeze(
			catalog.entries.map((entry) =>
				Object.freeze({
					address: Object.freeze({ definition: entry.address, variant: 'default' as const }),
					ctor: entry.candidate.implementation,
					displayName: entry.candidate.declaration.displayName,
					rootExportName: entry.address.exportName,
				}),
			),
		)
		return this.cachedEntries
	}

	findModuleId(address: PluginNodeAddress): string | null {
		return this.entry(address)?.provenance.moduleId ?? null
	}

	getCtor(address: PluginNodeAddress): PluginConstructor | undefined {
		return this.entry(address)?.candidate.implementation
	}

	getExportKey(address: PluginNodeAddress): string | undefined {
		return this.entry(address)?.address.exportName
	}

	getConfig(address: PluginNodeAddress): PluginConfigDefinition | undefined {
		return this.entry(address)?.candidate.declaration.config
	}

	private catalog(): PluginRouteCatalogSnapshot {
		return requireRuntimePluginGraphCoordinator(this.ctx).catalogSnapshot()
	}

	private entry(address: PluginNodeAddress) {
		return pluginCatalogEntry(this.catalog(), address.definition)
	}
}

export class LoaderAnchors {
	private cachedCatalog: PluginRouteCatalogSnapshot | undefined
	private all: ReadonlySet<string> = new Set<string>()
	private hmr: ReadonlySet<string> = new Set<string>()

	constructor(private readonly ctx: Context) {}

	has(moduleId: string): boolean {
		this.refresh()
		return this.all.has(moduleId)
	}

	list(): IterableIterator<string> {
		this.refresh()
		return this.all.values()
	}

	snapshot(): ReadonlySet<string> {
		this.refresh()
		return this.hmr
	}

	private refresh(): void {
		const catalog = requireRuntimePluginGraphCoordinator(this.ctx).catalogSnapshot()
		if (catalog === this.cachedCatalog) return
		const all = new Set<string>()
		const hmr = new Set<string>()
		for (const entry of catalog.entries) {
			const moduleId = entry.provenance.moduleId
			if (!moduleId || moduleId.startsWith('pluxel:fixed:')) continue
			all.add(moduleId)
			if (!moduleId.includes('/node_modules/')) hmr.add(moduleId)
		}
		this.cachedCatalog = catalog
		this.all = all
		this.hmr = hmr
	}
}

export class LoaderControl {
	constructor(private readonly ctx: Context) {}

	async setAutoStart(address: PluginNodeAddress, autoStart: boolean): Promise<void> {
		await requireRuntimePluginGraphCoordinator(this.ctx).updateRuntimeState(
			runtimeStatePatch({ type: 'set-auto-start', node: address, autoStart }),
			'plugin-auto-start-set',
		)
	}

	async start(address: PluginNodeAddress): Promise<void> {
		await requireRuntimePluginGraphCoordinator(this.ctx).startNode(address)
	}

	async stop(address: PluginNodeAddress): Promise<void> {
		await requireRuntimePluginGraphCoordinator(this.ctx).stopNode(address)
	}

	async restart(address: PluginNodeAddress): Promise<void> {
		await requireRuntimePluginGraphCoordinator(this.ctx).restartNode(address)
	}
}

export type LoaderApi = {
	status: PluginStatusReporter
	registry: LoaderRegistryView
	anchors: LoaderAnchors
	control: LoaderControl
}
