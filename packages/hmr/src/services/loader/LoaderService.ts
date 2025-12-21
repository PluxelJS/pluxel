// loader/index.ts
import { type Context, getPluginInfo, Injectable, type PluginConstructor } from '@pluxel/core'
import { buildSnapshot as buildSnapshotSource } from './buildSnapshot'
import { ModuleReplacer } from './module-replacer'
import { PluginRegistry } from './PluginRegistry'
import {
	LoaderBatchSession,
	LoaderControl,
	PluginDependencyInspector,
	PluginPruner,
	LoaderRegistryView,
	LoaderAnchors,
	PluginStatusReporter,
	RuntimeResolver,
	type LoaderApi,
	type RemovalScope,
} from './support'

export type { LoaderApi, RemovalScope } from './support'

const serviceName = 'loader' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: LoaderService
	}
}

@Injectable({ key: serviceName })
export class LoaderService {
	/** 仅记录“当前是插件锚点”的文件，供外部(HMR)过滤 */
	private readonly anchors = new Set<string>()
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

	constructor(private ctx: Context) {
		this.registry = new PluginRegistry(this.ctx)
		this.runtime = new RuntimeResolver(this.ctx, this.registry)
		this.moduleReplacer = new ModuleReplacer(
			this.ctx,
			this.registry,
			this.anchors,
			(name) => this.runtime.resolve(name),
			(moduleId) => this.runtime.normalizeId(moduleId),
		)
		this.pruner = new PluginPruner(
			this.ctx,
			this.registry,
			this.anchors,
			(moduleId) => this.runtime.normalizeId(moduleId),
		)
		this.statusReporter = new PluginStatusReporter(
			this.registry,
			this.runtime,
			(name) => this.ctx.configService.isEnabledInConfig(name),
		)
		this.dependencyInspector = new PluginDependencyInspector(this.ctx)
		this.registryView = new LoaderRegistryView(this.registry, this.runtime)
		this.anchorsView = new LoaderAnchors(this.anchors, this.runtime)
		this.control = new LoaderControl(this.registry)
		this.api = {
			runtime: this.runtime,
			status: this.statusReporter,
			deps: this.dependencyInspector,
			registry: this.registryView,
			anchors: this.anchorsView,
			control: this.control,
		}

		// --- 原子提交失败：回滚运行层（不触碰持久层启用位） ---
		this.ctx.on('commitFailed', (failed) => {
			for (const ctor of failed) {
				const { id: name } = getPluginInfo(ctor as PluginConstructor)
				this.registry.stopPlugin(name, ctor as PluginConstructor) // 只停运
			}
		})
	}

	// 先停旧运行态，再把"已执行的新模块"导出解析并装入。
	async replaceModule(moduleId: string, mod: Record<string, unknown>): Promise<boolean> {
		return this.moduleReplacer.replaceModule(moduleId, mod)
	}

	/**
	 * HMR 批量注入事务（loader 层的声明状态回滚）。
	 * - core 容器的草稿回滚由 `ctx.registry.resetDraft()`/commit 内部负责；
	 * - 这里确保 loader 自身不“先走一步”导致状态漂移。
	 */
	beginBatch() {
		return new LoaderBatchSession(this.moduleReplacer, this.registry.beginTransaction(), this.anchors)
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

	// ----------------------- 只读/工具 -----------------------
	// 公开只读 API 统一挂在 `loader.api`

	buildSnapshot(): string {
		return buildSnapshotSource({
			ctx: this.ctx,
			registry: this.registry,
			isRunning: (target) => this.runtime.isRunning(target),
		})
	}
}
