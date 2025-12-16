// loader/index.ts
import {
	BasePlugin,
	type Context,
	checkPluginDecorator,
	clearParamToken,
	getClassParams,
	getPluginInfo,
	Injectable,
	setParamToken,
	setParamTokens,
	type PluginConstructor,
} from '@pluxel/core'
import { buildSnapshot as buildSnapshotSource } from './buildSnapshot'
import {
	type PluginLifecycleSnapshot,
	type PluginLifecycleStage,
	PluginRegistry,
} from './PluginRegistry'
import { EXTRA_DEP_OVERRIDES, type DepOverridesExtra } from './selection'

// moduleId：一般指路径，一个文件可以有多个插件 ctor。
// config persisted 在 PluginRegistry 是在内核 this.ctx.registry 上的包装，让它和 moduleId 能联系起来。
// 如果同名插件来自于不同 moduleId 应该帮它c

/** 明确动作作用域：仅运行态，或运行态+持久启用位 */
export type RemovalScope = 'runtime' | 'persisted'

const serviceName = 'loader' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: LoaderService
	}
}

@Injectable({ key: serviceName })
export class LoaderService {
	/** 仅记录“当前是插件锚点”的文件，供外部(HMR)过滤 */
	public pathAnchors = new Set<string>()
	/** 声明层 + 运行层 + 配置层的统一封装 */
	public registry: PluginRegistry

	constructor(private ctx: Context) {
		this.registry = new PluginRegistry(this.ctx)

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
		return this.replaceModuleInternal(moduleId, mod)
	}

	/**
	 * HMR 批量注入事务（loader 层的声明状态回滚）。
	 * - core 容器的草稿回滚由 `ctx.registry.resetDraft()`/commit 内部负责；
	 * - 这里确保 loader 自身不“先走一步”导致状态漂移。
	 */
	beginBatch() {
		const tx = this.registry.beginTransaction()
		const anchorBefore = new Map<string, boolean>()

		const recordAnchor = (id: string) => {
			if (anchorBefore.has(id)) return
			anchorBefore.set(id, this.pathAnchors.has(id))
		}

		return {
			replaceModule: async (moduleId: string, mod: Record<string, unknown>) => {
				const id = this.normalizeModuleId(moduleId)
				recordAnchor(id)
				return this.replaceModuleInternal(id, mod, tx)
			},
			rollback: () => {
				tx.rollback()
				for (const [id, had] of anchorBefore) {
					if (had) this.pathAnchors.add(id)
					else this.pathAnchors.delete(id)
				}
			},
			commit: () => {
				tx.commit()
				anchorBefore.clear()
			},
		}
	}

	private async replaceModuleInternal(
		moduleIdOrNormalized: string,
		mod: Record<string, unknown>,
		tx?: ReturnType<PluginRegistry['beginTransaction']>,
	): Promise<boolean> {
		const id = tx ? moduleIdOrNormalized : this.normalizeModuleId(moduleIdOrNormalized)
		const oldItems = this.registry.modules.get(id) ?? []
		// 停旧（只影响运行层，保留声明关系以便冲突判断更清晰）
		this.registry.stopModule(id)

		// 清理旧声明，准备落新声明
		this.registry.undeclareModule(id, tx)

		let isAnchor = false
		const declared: PluginConstructor[] = []
		for (const [exportKey, exp] of Object.entries(mod)) {
			if (typeof exp !== 'function') continue
			if (!checkPluginDecorator(exp)) continue
			this.registry.declarePlugin(id, exp as PluginConstructor, exportKey, tx)
			declared.push(exp as PluginConstructor)
			isAnchor = true
		}

		// Apply persisted dependency overrides after all exports are declared
		for (const ctor of declared) this.applyStoredDependencyOverrides(ctor)

		// 运行层：根据持久启用位，自动启用需要启用的插件
		await this.registry.syncRuntimeForModule(id)
		this.refreshDependents(oldItems)

		// 维护锚点
		if (isAnchor) this.pathAnchors.add(id)
		else this.pathAnchors.delete(id)

		return isAnchor
	}

	/**
	 * Apply persisted constructor parameter token overrides (fork selection, etc.)
	 * onto a freshly declared ctor (important across HMR reloads).
	 */
	private applyStoredDependencyOverrides(ctor: PluginConstructor) {
		const getExtra = (this.ctx.configService as any)?.getExtra as
			| ((key: string) => unknown)
			| undefined
		if (typeof getExtra !== 'function') return

		const name = getPluginInfo(ctor).id
		const all = getExtra.call(this.ctx.configService, EXTRA_DEP_OVERRIDES) as
			| DepOverridesExtra
			| undefined
		const overrides = all?.[name]
		if (!overrides) return

		for (const [rawIndex, targetName] of Object.entries(overrides)) {
			const index = Number(rawIndex)
			if (!Number.isFinite(index) || index < 0) continue

			if (typeof targetName !== 'string' || targetName.trim() === '') {
				clearParamToken(ctor, index)
				continue
			}

			const token = this.resolveRuntimeCtor(targetName)
			if (!token) continue
			setParamToken(ctor, index, token as any)
		}
	}

	// ------------------------------------------------------------------
	// 2) 删除文件：停运并解除声明；scope 控制是否连持久启用位一起关
	// ------------------------------------------------------------------
	pruneModule(moduleId: string, scope: RemovalScope = 'runtime') {
		const id = this.normalizeModuleId(moduleId)
		if (scope === 'persisted') this.registry.disablePersistedByModule(id)
		this.registry.stopModule(id)
		this.registry.undeclareModule(id)
		this.pathAnchors.delete(id)
	}

	/** 按插件名清理运行态（找不到路径也能尽量关闭/禁用） */
	prunePluginByName(name: string, scope: RemovalScope = 'runtime') {
		const candidates = new Set<string>()
		const mapped = this.registry.name2PathMap.get(name)
		if (mapped) candidates.add(mapped)
		else {
			for (const [moduleId, items] of this.registry.modules) {
				if (items.some((item) => getPluginInfo(item.ctor).id === name)) {
					candidates.add(moduleId)
				}
			}
		}

		if (candidates.size === 0) {
			// 没找到模块路径，至少停运行态/禁持久启用
			const ctor = this.registry.getPluginByName(name)
			if (ctor) this.registry.stopPlugin(name, ctor)
			if (scope === 'persisted') this.ctx.configService.disableInConfig(name)
			return
		}

		for (const moduleId of candidates) {
			this.pruneModule(moduleId, scope)
		}
	}

	// ----------------------- 只读/工具 -----------------------
	getLoadedPluginsName(): string[] {
		return this.registry.getLoadedNames()
	}

	// 由于 HMR 的存在，普通运行时可能会缓存另一个 ctor 而不用vite内部缓存，通过调用该函数可以返回 HMR 那个。
	resolveRuntimeCtor(target: PluginConstructor | string): PluginConstructor | undefined {
		if (typeof target === 'string') {
			const hash = target.lastIndexOf('#')
			if (hash > 0) {
				const baseName = target.slice(0, hash)
				const forkId = target.slice(hash + 1)
				const baseCtor = this.registry.getPluginByName(baseName)
				if (baseCtor && forkId) {
					try {
						return this.ctx.registry.fork(baseCtor as any, forkId) as PluginConstructor
					} catch {
						// fall through
					}
				}
			}
			return this.registry.getPluginByName(target)
		}
		const { id: name } = getPluginInfo(target)
		return this.registry.getPluginByName(name) ?? target
	}

	isRunning(target: PluginConstructor | string): boolean {
		const ctor = this.resolveRuntimeCtor(target)
		if (!ctor) return false
		return this.ctx.registry.isRunning(ctor)
	}

	getFullPluginStatus() {
		const loaded = this.registry.names
		const statuses: Record<string, PluginLifecycleSnapshot> = Object.create(null)
		let running = 0
		let stopped = 0
		let disabled = 0
		for (const [name, ctor] of loaded) {
			const isRunning = this.isRunning(ctor)
			const isEnabled = this.ctx.configService.isEnabledInConfig(name)
			const lifecycleStage = this.deriveLifecycleStage(isRunning, isEnabled)
			statuses[name] = { id: name, isRunning, isEnabled, lifecycleStage }
			if (!isEnabled) disabled++
			else if (isRunning) running++
			else stopped++
		}
		return {
			statuses,
			summary: { total: running + stopped + disabled, running, stopped, disabled },
		}
	}

	getPluginDependenciesInfo(ctor: PluginConstructor) {
		return getClassParams<PluginConstructor>(ctor)
			.map((dep) => {
				if (typeof dep !== 'function') return undefined
				let name: string
				try {
					name = getPluginInfo(dep).id
				} catch {
					name = (dep as any)?.name ?? String(dep)
				}
				// Core registry can resolve abstract/base tokens via DI aliases.
				const isRunning = this.ctx.registry.isRunning(dep as any)
				return { name, isRunning }
			})
			.filter(Boolean) as Array<{ name: string; isRunning: boolean }>
	}

	getPluginSchema(target: PluginConstructor | string) {
		const ctor = this.resolveRuntimeCtor(target)
		if (ctor === undefined) return
		return this.registry.getSchema(ctor)
	}

	getPluginSchemaSource(target: PluginConstructor | string) {
		const ctor = this.resolveRuntimeCtor(target)
		if (ctor === undefined) return
		return this.registry.getSchemaSource(ctor)
	}

	buildSnapshot(): string {
		return buildSnapshotSource({
			ctx: this.ctx,
			registry: this.registry,
			isRunning: (target) => this.isRunning(target),
		})
	}

	/**
	 * 热更后，用当前 name -> ctor 映射重绑依赖者的构造参数引用，避免旧引用导致 MissingDependency。
	 * 只处理受影响插件的直接依赖者，开销低。
	 */
	private refreshDependents(oldItems: readonly { ctor: PluginConstructor }[]) {
		if (oldItems.length === 0) return
		const dependentsMap = this.ctx.registry.container?.dependents
		if (!dependentsMap?.size) return

		const affected = new Set<PluginConstructor>()
		for (const { ctor } of oldItems) {
			const deps = dependentsMap.get(ctor as any)
			if (!deps) continue
			for (const dep of deps) affected.add(dep as PluginConstructor)
		}
		if (affected.size === 0) return

		const nameMap = this.registry.names
		for (const depCtor of affected) {
			const params = getClassParams(depCtor)
			const next = params.slice()
			let mutated = false
			for (let i = 0; i < next.length; i++) {
				const p = next[i]
				if (typeof p !== 'function') continue
				if (!((p as any)?.prototype instanceof BasePlugin)) continue
				let pid: string
				try {
					pid = getPluginInfo(p as PluginConstructor).id
				} catch {
					continue
				}
				const current = nameMap.get(pid)
				if (current && current !== p) {
					next[i] = current
					mutated = true
				}
			}
			if (mutated) setParamTokens(depCtor, next as any)
		}
	}

	private deriveLifecycleStage(isRunning: boolean, isEnabled: boolean): PluginLifecycleStage {
		if (!isEnabled) return 'disabled'
		return isRunning ? 'running' : 'stopped'
	}

	private normalizeModuleId(moduleId: string) {
		// HMRService is optional in unit tests and some non-HMR runtimes.
		return (this.ctx as any)?.hmrService?.normalizeId?.(moduleId) ?? moduleId
	}
}
