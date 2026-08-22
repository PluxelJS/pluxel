import {
	getPluginInfo,
	Injectable,
	type Context as PluxelContext,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { createLoaderRuntimeRoute } from '../catalog/LoaderRuntimeRoute'
import { ModuleReplacer, type ReplaceModuleResult } from './module-replacer'
import { PluginRegistry, type PluginRegistryTransaction } from './PluginRegistry'
import {
	AnchorStore,
	type LoaderBatch,
	LoaderAnchors,
	type LoaderApi,
	LoaderBatchSession,
	LoaderControl,
	LoaderRegistryView,
	PluginDependencyInspector,
	PluginPruner,
	PluginStatusReporter,
	type LoaderSyncModulesOptions,
	type RemovalScope,
	RuntimeResolver,
} from './support'

export type { ReplaceModuleResult } from './module-replacer'
export type { LoaderApi, LoaderBatch, LoaderSyncModulesOptions, RemovalScope } from './support'

const serviceName = 'loader' as const

type RuntimeModuleUpdateBridge = {
	upsertModule(module: {
		moduleId: string
		items: ReadonlyArray<{ ctor: PluginConstructor }>
	}): void
	removeModule(moduleId: string): void
}

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: LoaderService
		}
	}
}

@Injectable({ key: serviceName })
export class LoaderService {
	private readonly anchors = new AnchorStore()
	private readonly registry: PluginRegistry
	private readonly runtime: RuntimeResolver
	private readonly moduleReplacer: ModuleReplacer
	private readonly pruner: PluginPruner
	public readonly api: LoaderApi

	constructor(public readonly ctx: PluxelContext) {
		this.registry = new PluginRegistry(this.ctx)
		this.runtime = new RuntimeResolver(this.ctx, this.registry)
		this.moduleReplacer = new ModuleReplacer(this.ctx, this.registry, this.anchors)
		this.pruner = new PluginPruner(this.registry, this.anchors)
		this.api = {
			runtime: this.runtime,
			status: new PluginStatusReporter(this.ctx, this.registry, this.runtime),
			deps: new PluginDependencyInspector(this.ctx, this.registry),
			registry: new LoaderRegistryView(this.registry),
			anchors: new LoaderAnchors(this.anchors),
			control: new LoaderControl(this.registry),
		}
		this.ctx.runtimeRoute = createLoaderRuntimeRoute(this.ctx, this.api)
	}

	/** Register the immutable catalog owned by one evaluated config generation. */
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

		const runtimeUpdate = this.ctx.registry.beginUpdate({ reason: 'startup' })
		const tx = this.registry.beginTransaction({ runtimeUpdate })
		const seen = new Set<PluginConstructor>()
		const declared: PluginNodeAddress[] = []

		try {
			for (const ctor of plugins) {
				if (seen.has(ctor)) continue
				seen.add(ctor)
				const info = getPluginInfo(ctor)
				declared.push(this.registry.declarePlugin(options.moduleId, ctor, info.rootExportName, tx))
			}
			await this.registry.syncRuntimeForModule(options.moduleId, { tx })
			const commitResult = await runtimeUpdate.commit({ rollbackOnFailure: false })
			if (!commitResult.ok) {
				throw new Error('fixed catalog commit failed', { cause: commitResult.err })
			}
			tx.commit()
			return declared
		} catch (error) {
			tx.rollback()
			runtimeUpdate.rollback()
			throw error
		}
	}

	/** Evaluate/inject one source module as an atomic catalog+Core transaction. */
	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
	): Promise<ReplaceModuleResult> {
		const runtimeUpdate = this.ctx.registry.beginUpdate({ reason: 'dynamic-source' })
		const batch = this.beginBatch({ runtimeUpdate })
		try {
			const result = await batch.replaceModule(moduleId, mod)
			runtimeUpdate.markAffectedModules([moduleId, ...result.affectedModules])
			await batch.syncModules(result.affectedModules, { exclude: [moduleId] })
			const committed = await runtimeUpdate.commit({ rollbackOnFailure: false })
			if (!committed.ok) {
				throw new Error(`Dynamic source commit failed for ${moduleId}`, {
					cause: committed.err,
				})
			}
			batch.commit()
			return result
		} catch (error) {
			batch.rollback()
			runtimeUpdate.rollback()
			throw error
		}
	}

	beginBatch(options: { runtimeUpdate?: RuntimeModuleUpdateBridge } = {}): LoaderBatch {
		const tx = this.registry.beginTransaction({ runtimeUpdate: options.runtimeUpdate })
		return new LoaderBatchSession(this.moduleReplacer, tx, this.anchors, (moduleIds, syncOptions) =>
			this.syncRuntimeForModules(moduleIds, syncOptions, tx),
		)
	}

	pruneModule(moduleId: string, scope: RemovalScope = 'runtime'): void {
		this.pruner.pruneModule(moduleId, scope)
	}

	private async syncRuntimeForModules(
		moduleIds: Iterable<string>,
		options: LoaderSyncModulesOptions = {},
		tx?: PluginRegistryTransaction,
	): Promise<readonly string[]> {
		const seen = new Set<string>()
		const excluded = options.exclude ? new Set(options.exclude) : undefined
		const synced: string[] = []
		for (const moduleId of moduleIds) {
			if (excluded?.has(moduleId) || seen.has(moduleId)) continue
			seen.add(moduleId)
			await this.registry.syncRuntimeForModule(moduleId, {
				tx,
				forceRegistrations: options.forceRegistrations,
			})
			synced.push(moduleId)
		}
		return synced
	}
}
