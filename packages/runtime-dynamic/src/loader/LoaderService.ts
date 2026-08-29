import {
	type Context as PluxelContext,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	installRuntimePluginGraphCoordinator,
	installRuntimeRouteCapabilities,
	requireRuntimePluginGraphCoordinator,
} from '@pluxel/runtime/internal'
import { createLoaderRuntimeRoute } from '../catalog/LoaderRuntimeRoute'
import { ModuleReplacer, type ReplaceModuleResult } from './module-replacer'
import { createPluginCatalogDraft } from './PluginCatalogDraft'
import {
	type LoaderBatch,
	LoaderAnchors,
	type LoaderApi,
	LoaderBatchSession,
	LoaderControl,
	LoaderRegistryView,
	PluginStatusReporter,
} from './support'

export type { ReplaceModuleResult } from './module-replacer'
export type { LoaderApi, LoaderBatch, LoaderBatchCommitOptions } from './support'

export class LoaderService {
	private readonly moduleReplacer = new ModuleReplacer()
	public readonly api: LoaderApi

	constructor(public readonly ctx: PluxelContext) {
		installRuntimePluginGraphCoordinator(this.ctx)
		this.api = {
			status: new PluginStatusReporter(this.ctx),
			registry: new LoaderRegistryView(this.ctx),
			anchors: new LoaderAnchors(this.ctx),
			control: new LoaderControl(this.ctx),
		}
		const uninstallRoute = installRuntimeRouteCapabilities(
			this.ctx,
			createLoaderRuntimeRoute(this.api),
		)
		this.ctx.effects.defer(uninstallRoute, {
			tag: 'RuntimeRouteCapabilities',
			phase: 'shutdown',
		})
	}

	/** Publish the immutable catalog owned by one evaluated config generation. */
	async registerFixedPlugins(
		plugins: readonly PluginConstructor[],
		options: { moduleId: string },
	): Promise<readonly PluginNodeAddress[]> {
		if (plugins.length === 0) return []
		if (!options.moduleId.startsWith('pluxel:fixed:')) {
			throw new Error(
				'[runtime-dynamic] fixed catalog owner must be derived from the config module',
			)
		}

		const batch = this.beginBatch()
		const seen = new Set<PluginConstructor>()
		const declared: PluginNodeAddress[] = []
		try {
			batch.removeModule(options.moduleId)
			for (const implementation of plugins) {
				if (seen.has(implementation)) continue
				seen.add(implementation)
				declared.push(batch.declarePlugin(options.moduleId, implementation))
			}
			await batch.commit({ reason: 'fixed-catalog', mode: 'cold-boot' })
			return Object.freeze(declared)
		} catch (error) {
			batch.rollback()
			throw error
		}
	}

	/** Evaluate/inject one source module through the common catalog coordinator. */
	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
	): Promise<ReplaceModuleResult> {
		const batch = this.beginBatch()
		try {
			const result = await batch.replaceModule(moduleId, mod)
			await batch.commit({ reason: 'dynamic-source' })
			return result
		} catch (error) {
			batch.rollback()
			throw error
		}
	}

	beginBatch(): LoaderBatch {
		const catalog = requireRuntimePluginGraphCoordinator(this.ctx).catalogSnapshot()
		return new LoaderBatchSession(this.moduleReplacer, createPluginCatalogDraft(catalog), this.ctx)
	}

	async pruneModule(moduleId: string): Promise<void> {
		const batch = this.beginBatch()
		try {
			batch.removeModule(moduleId)
			await batch.commit({ reason: 'dynamic-source-remove' })
		} catch (error) {
			batch.rollback()
			throw error
		}
	}

	async shutdown(): Promise<void> {
		const batch = this.beginBatch()
		try {
			const moduleIds = new Set<string>()
			for (const entry of requireRuntimePluginGraphCoordinator(this.ctx).catalogSnapshot()
				.entries) {
				if (entry.provenance.moduleId) moduleIds.add(entry.provenance.moduleId)
			}
			for (const moduleId of moduleIds) batch.removeModule(moduleId)
			await batch.commit({ reason: 'shutdown', mode: 'live' })
		} catch (error) {
			batch.rollback()
			throw error
		}
	}
}
