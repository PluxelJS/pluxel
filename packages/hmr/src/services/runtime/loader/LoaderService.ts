// loader/index.ts
import type { ForkablePluginConstructor } from '@pluxel/core'
import { type Context, getPluginInfo, Injectable, type PluginConstructor } from '@pluxel/core'
import { ModuleReplacer } from './module-replacer'
import { PluginRegistry } from './PluginRegistry'
import { EXTRA_FORKS, type ForksExtra } from './selection'
import {
	AnchorStore,
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

export type { LoaderApi, RemovalScope } from './support'

const serviceName = 'loader' as const
const BUILTIN_MODULE_ID_DEFAULT = 'pluxel:builtins'

export type BuiltinForkSpec = string | { id: string; enable?: boolean }
export type BuiltinPluginSpec =
	| PluginConstructor
	| {
			plugin: PluginConstructor
			enable?: boolean
			/**
			 * Source module specifier for this builtin.
			 *
			 * Defaults to a synthetic module id ("pluxel:builtins") so builtins are easy to identify
			 * in reports and UI tooling.
			 */
			moduleId?: string
			/**
			 * Workspace package name for this builtin (used by workspace-profile discovery to omit
			 * the same package from startup entries and prevent "plugin name conflict").
			 *
			 * Keep this separate from `moduleId`: `moduleId` is for "who declared the plugin",
			 * while `packageName` is for "which workspace package should not be scanned as a plugin entry".
			 */
			packageName?: string
			/** Export key within `moduleId` (e.g. "default" or "MyPlugin"). */
			exportKey?: string
			forks?: readonly BuiltinForkSpec[]
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

	constructor(public ctx: Context) {
		this.registry = new PluginRegistry(this.ctx)
		this.runtime = new RuntimeResolver(this.ctx, this.registry)
		this.moduleReplacer = new ModuleReplacer(
			this.ctx,
			this.registry,
			this.anchors,
			(name) => this.runtime.resolve(name),
		)
		this.pruner = new PluginPruner(this.ctx, this.registry, this.anchors)
		this.statusReporter = new PluginStatusReporter(this.registry, this.runtime, (name) =>
			this.ctx.configService.isEnabledInConfig(name),
		)
		this.dependencyInspector = new PluginDependencyInspector(this.ctx)
		this.registryView = new LoaderRegistryView(this.registry, this.runtime)
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

		// --- 原子提交失败：回滚运行层（不触碰持久层启用位） ---
		this.ctx.on('commitFailed', (failed) => {
			for (const ctor of failed) {
				const { id: name } = getPluginInfo(ctor as PluginConstructor)
				this.registry.stopPlugin(name, ctor as PluginConstructor) // 只停运
			}
		})
	}

	/**
	 * Preload "built-in" plugin constructors without requiring a scanned entry file.
	 *
	 * Notes:
	 * - This commits immediately by default so the resulting baseline container survives later batch rollbacks.
	 * - The loader declaration layer is updated under a synthetic module id so UI tooling can locate them.
	 */
	async preloadPlugins(
		plugins: readonly BuiltinPluginSpec[],
		options: { moduleId?: string; commit?: boolean } = {},
	): Promise<string[]> {
		if (!plugins.length) return []
		const defaultModuleId = options.moduleId ?? BUILTIN_MODULE_ID_DEFAULT
		const shouldCommit = options.commit !== false

		const tx = this.registry.beginTransaction()
		const seen = new Set<PluginConstructor>()
		const declared: Array<{ name: string; ctor: PluginConstructor; enable: boolean }> = []
		const forksToEnable: Array<{ name: string; ctor: PluginConstructor }> = []
		let touchedCoreDraft = false
		const prevForksExtra = this.ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS) ?? {}
		let forksExtraDirty = false
		const forkSets = new Map<string, Set<string>>()

		try {
			for (const spec of plugins) {
				const ctor = typeof spec === 'function' ? spec : spec.plugin
				if (seen.has(ctor)) continue
				seen.add(ctor)
				const enable = typeof spec === 'function' ? true : spec.enable !== false
				const moduleId =
					typeof spec === 'function' ? defaultModuleId : (spec.moduleId ?? defaultModuleId)
				const exportKey = typeof spec === 'function' ? 'default' : (spec.exportKey ?? 'default')

				const declaredName = this.registry.declarePlugin(moduleId, ctor, exportKey, tx)
				declared.push({ name: declaredName, ctor, enable })

				const forks = typeof spec === 'function' ? undefined : spec.forks
				if (forks?.length) {
					for (const forkSpec of forks) {
						const forkId = typeof forkSpec === 'string' ? forkSpec.trim() : forkSpec.id.trim()
						if (!forkId) continue

						let set = forkSets.get(declaredName)
						if (!set) {
							const seed = Array.isArray(prevForksExtra[declaredName])
								? prevForksExtra[declaredName]
								: []
							set = new Set(seed)
							forkSets.set(declaredName, set)
						}
						const before = set.size
						set.add(forkId)
						if (set.size !== before) forksExtraDirty = true

						const forkEnable = typeof forkSpec === 'string' ? true : forkSpec.enable !== false
						if (!forkEnable) continue
						const forkName = `${declaredName}#${forkId}`
						const forkCtor = this.ctx.registry.fork(
							ctor as unknown as ForkablePluginConstructor,
							forkId,
						) as PluginConstructor
						forksToEnable.push({ name: forkName, ctor: forkCtor })
					}
				}
			}

			if (forksExtraDirty) {
				const next: ForksExtra = { ...prevForksExtra }
				for (const [baseName, set] of forkSets) next[baseName] = [...set]
				this.ctx.configService.batch(() => {
					this.ctx.configService.setExtra(EXTRA_FORKS, next)
				})
			}

			const enabledByUs: string[] = []
			for (const item of declared) {
				if (!item.enable) continue
				const wasEnabled = this.ctx.configService.isEnabledInConfig(item.name)
				await this.registry.enable(item.name, item.ctor)
				touchedCoreDraft = true
				if (!wasEnabled) enabledByUs.push(item.name)
			}
			for (const fork of forksToEnable) {
				const wasEnabled = this.ctx.configService.isEnabledInConfig(fork.name)
				await this.registry.enable(fork.name, fork.ctor)
				touchedCoreDraft = true
				if (!wasEnabled) enabledByUs.push(fork.name)
			}

			if (shouldCommit) {
				const res = await this.ctx.registry.commit()
				if (!res.ok) {
					// Keep persisted state consistent: revert enable bits that were introduced by this call.
					for (const n of enabledByUs) this.ctx.configService.disableInConfig(n)
					if (forksExtraDirty) this.ctx.configService.setExtra(EXTRA_FORKS, prevForksExtra)
					tx.rollback()
					this.ctx.registry.resetDraft()
					throw new Error('builtin preload commit failed', { cause: res.err })
				}
			}

			tx.commit()
			return declared.map((d) => d.name)
		} catch (error) {
			if (forksExtraDirty) this.ctx.configService.setExtra(EXTRA_FORKS, prevForksExtra)
			tx.rollback()
			if (touchedCoreDraft) this.ctx.registry.resetDraft()
			throw error
		}
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
		return new LoaderBatchSession(
			this.moduleReplacer,
			this.registry.beginTransaction(),
			this.anchors,
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
}
