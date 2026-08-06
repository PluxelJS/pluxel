// loader/index.ts
import {
	collectPluginLifecycleNotStarted,
	type CommitSummary,
	type Context as PluxelContext,
	getPluginInfo,
	Injectable,
	type PluginConstructor,
} from '@pluxel/core'
import { isPluginEnabled } from '@pluxel/runtime/internal'
import { ModuleReplacer, type ReplaceModuleResult } from './module-replacer'
import { PluginRegistry } from './PluginRegistry'
import { createLoaderRuntimeRoute } from '../catalog/LoaderRuntimeRoute'
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
	type RemovalScope,
	RuntimeResolver,
} from './support'

export type { ReplaceModuleResult } from './module-replacer'
export type { LoaderApi, LoaderBatch, LoaderSyncModulesOptions, RemovalScope } from './support'

const serviceName = 'loader' as const
type RuntimeModuleUpdateBridge = {
	upsertModule(module: {
		moduleId: string
		items: ReadonlyArray<{ ctor: PluginConstructor; exportKey?: string }>
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
	/** 仅记录“当前是插件锚点”的文件，供外部(HMR)过滤 */
	private readonly anchors = new AnchorStore()
	/** 声明层 + 运行层 + 配置层的统一封装 */
	private readonly registry: PluginRegistry

	private readonly runtime: RuntimeResolver
	private readonly moduleReplacer: ModuleReplacer
	private readonly pruner: PluginPruner
	private readonly statusReporter: PluginStatusReporter
	private readonly dependencyInspector: PluginDependencyInspector
	private readonly registryView: LoaderRegistryView
	private readonly anchorsView: LoaderAnchors
	private readonly control: LoaderControl
	// Stable public API surface for external callers (RPC/HMR/Extension).
	public readonly api: LoaderApi

	constructor(public ctx: PluxelContext) {
		this.registry = new PluginRegistry(this.ctx)
		this.runtime = new RuntimeResolver(this.ctx, this.registry)
		this.moduleReplacer = new ModuleReplacer(this.ctx, this.registry, this.anchors, (name) =>
			this.runtime.resolve(name),
		)
		this.pruner = new PluginPruner(this.ctx, this.registry, this.anchors)
		this.statusReporter = new PluginStatusReporter(this.registry, this.runtime, (name) =>
			this.isEnabled(name),
		)
		this.dependencyInspector = new PluginDependencyInspector(this.ctx)
		this.registryView = new LoaderRegistryView(this.ctx, this.registry, this.runtime)
		this.anchorsView = new LoaderAnchors(this.anchors)
		this.control = new LoaderControl(this.registry)
		this.api = {
			runtime: this.runtime,
			status: this.statusReporter,
			deps: this.dependencyInspector,
			registry: this.registryView,
			anchors: this.anchorsView,
			control: this.control,
		}
		this.ctx.runtimeRoute = createLoaderRuntimeRoute(this.ctx, this.api)

		this.ctx.internalEvent.runtimeCommitted.on((summary) => {
			this.cleanupNotStartedRuntimeRegistrations(summary)
		})
	}

	private isEnabled(name: string): boolean {
		return isPluginEnabled(this.ctx.runtimeState.snapshot(), name)
	}

	private cleanupNotStartedRuntimeRegistrations(summary: CommitSummary): void {
		for (const key of collectPluginLifecycleNotStarted(summary.lifecycleReport)) {
			const name = String(key)
			const ctor = this.runtime.resolve(name)
			if (!ctor) continue
			this.registry.stopPlugin(name, ctor)
		}
	}

	/** Registers the immutable catalog owned by one dynamic config generation. */
	async registerFixedPlugins(
		plugins: readonly PluginConstructor[],
		options: { moduleId: string },
	): Promise<readonly string[]> {
		if (plugins.length === 0) return []
		if (!options.moduleId.startsWith('pluxel:fixed:')) {
			throw new Error(
				'[runtime-dynamic] fixed catalog owner must be derived from the config module',
			)
		}

		const runtimeUpdate = this.ctx.registry.beginUpdate({ reason: 'startup' })
		const tx = this.registry.beginTransaction({ runtimeUpdate })
		const seen = new Set<PluginConstructor>()
		const constructorById = new Map<string, PluginConstructor>()
		const declared: Array<{ name: string; ctor: PluginConstructor }> = []

		try {
			for (const ctor of plugins) {
				if (seen.has(ctor)) continue
				seen.add(ctor)
				const name = getPluginInfo(ctor).id
				const existing = constructorById.get(name)
				if (existing && existing !== ctor) {
					throw new Error(`[runtime-dynamic] fixed catalog contains duplicate plugin id "${name}"`)
				}
				constructorById.set(name, ctor)
				this.registry.declarePlugin(options.moduleId, ctor, name, tx)
				declared.push({ name, ctor })
			}

			await this.registry.syncRuntimeForModule(options.moduleId)

			const commitResult = await runtimeUpdate.commit({ rollbackOnFailure: false })
			if (!commitResult.ok) {
				throw new Error('fixed catalog commit failed', { cause: commitResult.err })
			}

			tx.commit()
			return declared.map((item) => item.name)
		} catch (error) {
			tx.rollback()
			runtimeUpdate.rollback()
			throw error
		}
	}

	// 先停旧运行态，再把"已执行的新模块"导出解析并装入。
	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
	): Promise<ReplaceModuleResult> {
		const result = await this.moduleReplacer.replaceModule(moduleId, mod)
		await this.syncRuntimeForModules(result.affectedModules, { exclude: [moduleId] })
		return result
	}

	/**
	 * HMR 批量注入事务（loader 层的声明状态回滚）。
	 * - core 容器的草稿回滚由调用方的 runtime update transaction 负责；
	 * - 这里确保 loader 自身不“先走一步”导致状态漂移。
	 */
	beginBatch(options: { runtimeUpdate?: RuntimeModuleUpdateBridge } = {}): LoaderBatch {
		return new LoaderBatchSession(
			this.moduleReplacer,
			this.registry.beginTransaction({ runtimeUpdate: options.runtimeUpdate }),
			this.anchors,
			(moduleIds, syncOptions) => this.syncRuntimeForModules(moduleIds, syncOptions),
		)
	}

	// ------------------------------------------------------------------
	// 2) 删除文件：停运并解除声明；scope 控制是否连持久启用位一起关
	// ------------------------------------------------------------------
	pruneModule(moduleId: string, scope: RemovalScope = 'runtime') {
		this.pruner.pruneModule(moduleId, scope)
	}

	/** 按插件名清理运行态（找不到路径也能尽量关闭/禁用） */
	prunePluginByName(name: string, scope: RemovalScope = 'runtime') {
		this.pruner.prunePluginByName(name, scope)
	}

	/**
	 * Re-apply config enablement for a module into core draft.
	 *
	 * Used by the HMR pipeline when commit retries are needed (e.g. MissingDependency auto-disable),
	 * because core rolls draft changes back internally on verification failure.
	 */
	private async syncRuntimeForModule(moduleId: string): Promise<void> {
		await this.registry.syncRuntimeForModule(moduleId, {
			refreshRegistered: true,
			restartRegistered: true,
		})
	}

	private async syncRuntimeForModules(
		moduleIds: Iterable<string>,
		options: { exclude?: Iterable<string> } = {},
	): Promise<readonly string[]> {
		const seen = new Set<string>()
		const excluded = options.exclude ? new Set(options.exclude) : undefined
		const synced: string[] = []
		for (const moduleId of moduleIds) {
			if (excluded?.has(moduleId)) continue
			if (seen.has(moduleId)) continue
			seen.add(moduleId)
			await this.syncRuntimeForModule(moduleId)
			synced.push(moduleId)
		}
		return synced
	}
}
