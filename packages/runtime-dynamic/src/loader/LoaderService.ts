// loader/index.ts
import {
	type Context as PluxelContext,
	type ForkablePluginConstructor,
	formatForkPluginId,
	getPluginInfo,
	Injectable,
	type PluginConstructor,
} from '@pluxel/core'
import {
	disablePluginsOnMissingDependencyError,
	type MissingDepsCandidate,
} from '@pluxel/runtime/shared'
import { ModuleReplacer, type ReplaceModuleResult } from './module-replacer'
import { PluginRegistry } from './PluginRegistry'
import {
	type BuiltinsKnownExtra,
	EXTRA_BUILTINS_KNOWN,
	EXTRA_FORKS,
	type ForksExtra,
} from './selection'
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
const BUILTIN_MODULE_ID_DEFAULT = 'pluxel:builtins'

export type BuiltinForkSpec = string | { id: string; enable?: boolean }
export type PreloadBuiltinsOptions = {
	moduleId?: string
	/**
	 * Whether to commit immediately after enabling builtins.
	 *
	 * @default true
	 */
	commit?: boolean
	/**
	 * Strict mode:
	 * - `true`: commit failures throw (fail-fast).
	 * - `false`: commit failures are logged and ignored (best-effort; UI remains available).
	 *
	 * @default false
	 */
	strict?: boolean
	/**
	 * When `strict=false`, automatically disable plugins that fail DI verification due to missing dependencies
	 * (then retry preload/commit with the remaining enabled plugins).
	 *
	 * This keeps the host usable even when a plugin is temporarily broken or its dependency is not installed.
	 *
	 * @default true
	 */
	autoDisableMissingDependencies?: boolean
	/**
	 * Safety cap for auto-disable retries (avoid infinite loops on unexpected errors).
	 *
	 * @default 8
	 */
	autoDisableMaxPasses?: number
}
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

	constructor(public ctx: PluxelContext) {
		this.registry = new PluginRegistry(this.ctx)
		this.runtime = new RuntimeResolver(this.ctx, this.registry)
		this.moduleReplacer = new ModuleReplacer(this.ctx, this.registry, this.anchors, (name) =>
			this.runtime.resolve(name),
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
		options: PreloadBuiltinsOptions = {},
	): Promise<string[]> {
		if (plugins.length === 0) return []
		const defaultModuleId = options.moduleId ?? BUILTIN_MODULE_ID_DEFAULT
		const shouldCommit = options.commit !== false
		const strict = options.strict ?? false
		const autoDisableMissingDependencies = options.autoDisableMissingDependencies ?? !strict
		const autoDisableMaxPasses = options.autoDisableMaxPasses ?? 8

		const tx = this.registry.beginTransaction()
		const runtimeUpdate = shouldCommit
			? this.ctx.registry.beginUpdate({ reason: 'startup' })
			: null
		const seen = new Set<PluginConstructor>()
		const declared: Array<{ name: string; ctor: PluginConstructor; defaultEnable: boolean }> = []
		const declaredForks: Array<{
			name: string
			ctor: PluginConstructor
			defaultEnable: boolean
		}> = []
		let touchedCoreDraft = false
		const prevForksExtra = this.ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS) ?? {}
		let forksExtraDirty = false
		const forkSets = new Map<string, Set<string>>()
		const prevKnownExtra =
			this.ctx.configService.getExtra<BuiltinsKnownExtra>(EXTRA_BUILTINS_KNOWN) ?? {}
		let knownDirty = false
		let nextKnownExtra: BuiltinsKnownExtra | undefined
		const enabledByUs: string[] = []

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
				declared.push({ name: declaredName, ctor, defaultEnable: enable })

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
						const forkName = formatForkPluginId(declaredName, forkId)
						const forkCtor = this.ctx.registry.fork(
							ctor as unknown as ForkablePluginConstructor,
							forkId,
						) as PluginConstructor
						declaredForks.push({ name: forkName, ctor: forkCtor, defaultEnable: forkEnable })
					}
				}
			}

			const enableTargets: Array<{
				name: string
				ctor: PluginConstructor
				defaultEnable: boolean
				knownBefore: boolean
			}> = []

			const ensureKnown = (name: string) => {
				if (prevKnownExtra[name] === 1) return
				if (!nextKnownExtra) nextKnownExtra = { ...prevKnownExtra }
				if (nextKnownExtra[name] === 1) return
				nextKnownExtra[name] = 1
				knownDirty = true
			}

			for (const item of declared) {
				const knownBefore = prevKnownExtra[item.name] === 1
				enableTargets.push({
					name: item.name,
					ctor: item.ctor,
					defaultEnable: item.defaultEnable,
					knownBefore,
				})
				if (!knownBefore) ensureKnown(item.name)
			}
			for (const fork of declaredForks) {
				const knownBefore = prevKnownExtra[fork.name] === 1
				enableTargets.push({
					name: fork.name,
					ctor: fork.ctor,
					defaultEnable: fork.defaultEnable,
					knownBefore,
				})
				if (!knownBefore) ensureKnown(fork.name)
			}

			if (forksExtraDirty || knownDirty) {
				this.ctx.configService.batch(() => {
					if (forksExtraDirty) {
						const next: ForksExtra = { ...prevForksExtra }
						for (const [baseName, set] of forkSets) next[baseName] = [...set]
						this.ctx.configService.setExtra(EXTRA_FORKS, next)
					}
					if (knownDirty) {
						this.ctx.configService.setExtra(EXTRA_BUILTINS_KNOWN, nextKnownExtra!)
					}
				})
			}

			const startTargetsWithSeeding = async () => {
				for (const t of enableTargets) {
					const wasEnabled = this.ctx.configService.isEnabledInConfig(t.name)
					const shouldSeed = t.defaultEnable && !t.knownBefore
					if (!wasEnabled && !shouldSeed) continue
					await this.registry.enable(t.name, t.ctor)
					touchedCoreDraft = true
					if (!wasEnabled) enabledByUs.push(t.name)
				}
			}

			const enableTargetsIfEnabledInConfig = async () => {
				for (const t of enableTargets) {
					if (!this.ctx.configService.isEnabledInConfig(t.name)) continue
					await this.registry.enable(t.name, t.ctor)
					touchedCoreDraft = true
				}
			}

			await startTargetsWithSeeding()

			if (shouldCommit) {
				const candidates: MissingDepsCandidate[] = enableTargets.map((t) => {
					let pluginId: string | undefined
					try {
						pluginId = getPluginInfo(t.ctor).id
					} catch {
						pluginId = undefined
					}
					return { name: t.name, ctorName: t.ctor?.name, pluginId }
				})

				let pass = 0
				let res = await runtimeUpdate!.commit({ rollbackOnFailure: false })
				while (
					!res.ok &&
					!strict &&
					autoDisableMissingDependencies &&
					pass < autoDisableMaxPasses
				) {
					const disabled = disablePluginsOnMissingDependencyError({
						error: res.err,
						candidates,
						isEnabled: (name) => this.ctx.configService.isEnabledInConfig(name),
						disable: (name) => this.ctx.configService.disableInConfig(name),
						batch: (run) => this.ctx.configService.batch(run),
						logger: this.ctx.logger,
						stage: 'builtins preload',
					})
					if (disabled.size === 0) break

					// Commit failure rolls core draft back internally; enable remaining plugins again and retry
					// within the same runtime update transaction.
					await enableTargetsIfEnabledInConfig()
					res = await runtimeUpdate!.commit({ rollbackOnFailure: false })
					pass++
				}

				if (!res.ok) {
					// Keep persisted state consistent: revert enable bits that were introduced by this call.
					for (const n of enabledByUs) this.ctx.configService.disableInConfig(n)
					if (forksExtraDirty) this.ctx.configService.setExtra(EXTRA_FORKS, prevForksExtra)
					if (knownDirty) this.ctx.configService.setExtra(EXTRA_BUILTINS_KNOWN, prevKnownExtra)
					tx.rollback()
					runtimeUpdate!.rollback()

					if (strict) throw new Error('builtin preload commit failed', { cause: res.err })
					this.ctx.logger.error('builtin preload commit failed', { error: res.err })
					return []
				}
			}

			tx.commit()
			return declared.map((d) => d.name)
		} catch (error) {
			// Keep persisted state consistent: revert enable bits introduced by this call.
			for (const n of enabledByUs) this.ctx.configService.disableInConfig(n)
			if (forksExtraDirty) this.ctx.configService.setExtra(EXTRA_FORKS, prevForksExtra)
			if (knownDirty) this.ctx.configService.setExtra(EXTRA_BUILTINS_KNOWN, prevKnownExtra)
			tx.rollback()
			if (runtimeUpdate) runtimeUpdate.rollback()
			else if (touchedCoreDraft) this.ctx.registry.resetDraft()
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
	beginBatch(): LoaderBatch {
		return new LoaderBatchSession(
			this.moduleReplacer,
			this.registry.beginTransaction(),
			this.anchors,
			(moduleIds, options) => this.syncRuntimeForModules(moduleIds, options),
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
		this.moduleReplacer.syncModuleParams(moduleId)
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
