// loader/index.ts
import {
	type Context,
	checkPluginDecorator,
	getClassParams,
	getPluginInfo,
	Injectable,
	type PluginConstructor,
} from '@pluxel/core'
import { buildSnapshot as buildSnapshotSource } from './buildSnapshot'
import {
	PluginRegistry,
	type PluginLifecycleSnapshot,
	type PluginLifecycleStage,
} from './PluginRegistry'

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

		// --- 生命周期：启动前把校验过/补齐过的配置灌入实例 ---
		this.ctx.on('beforeStart', (plugin) => {
			const ctor = plugin.constructor as PluginConstructor
			const schemaMap = this.registry.getSchema(ctor)
			if (!schemaMap) return
			const { name } = plugin.ctx.pluginInfo
			const { configRecord } = plugin.ctx.configService.getConfig(name)
			for (const key of Object.keys(schemaMap)) {
				;(plugin as any)[key] = (configRecord as any)[key]
			}
		})

		// --- 原子提交失败：回滚运行层（不触碰持久层启用位） ---
		this.ctx.on('commitFailed', (failed) => {
			for (const ctor of failed) {
				const { name } = getPluginInfo(ctor as PluginConstructor)
				this.registry.stopPlugin(name, ctor as PluginConstructor) // 只停运
			}
		})
	}

	// 先停旧运行态，再把“已执行的新模块”导出解析并装入。
	replaceModule(moduleId: string, mod: Record<string, unknown>): boolean {
		// 停旧（只影响运行层，保留声明关系以便冲突判断更清晰）
		this.registry.stopModule(moduleId)

		// 清理旧声明，准备落新声明
		this.registry.undeclareModule(moduleId)

		let isAnchor = false
		for (const [exportKey, exp] of Object.entries(mod)) {
			if (typeof exp !== 'function') continue
			if (!checkPluginDecorator(exp)) continue
			this.registry.declarePlugin(moduleId, exp as PluginConstructor, exportKey)
			isAnchor = true
		}

		// 运行层：根据持久启用位，自动启用需要启用的插件
		this.registry.syncRuntimeForModule(moduleId)

		// 维护锚点
		if (isAnchor) this.pathAnchors.add(moduleId)
		else this.pathAnchors.delete(moduleId)

		return isAnchor
	}

	// ------------------------------------------------------------------
	// 2) 删除文件：停运并解除声明；scope 控制是否连持久启用位一起关
	// ------------------------------------------------------------------
	pruneModule(moduleId: string, scope: RemovalScope = 'runtime') {
		if (scope === 'persisted') this.registry.disablePersistedByModule(moduleId)
		this.registry.stopModule(moduleId)
		this.registry.undeclareModule(moduleId)
		this.pathAnchors.delete(moduleId)
	}

	/** 按插件名清理运行态（找不到路径也能尽量关闭/禁用） */
	prunePluginByName(name: string, scope: RemovalScope = 'runtime') {
		const candidates = new Set<string>()
		const mapped = this.registry.name2PathMap.get(name)
		if (mapped) candidates.add(mapped)
		else {
			for (const [moduleId, items] of this.registry.modules) {
				if (items.some((item) => getPluginInfo(item.ctor).name === name)) {
					candidates.add(moduleId)
				}
			}
		}

		if (candidates.size === 0) {
			// 没找到模块路径，至少停运行态/禁持久启用
			const ctor = this.registry.getPluginByName(name)
			if (ctor) this.registry.stopPlugin(name, ctor)
			if (scope === 'persisted') this.ctx.configService.disablePlugin(name)
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
		if (typeof target === 'string') return this.registry.getPluginByName(target)
		const { name } = getPluginInfo(target)
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
			const isEnabled = this.ctx.configService.isEnable(name)
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
				const { name } = getPluginInfo(dep)
				return { name, isRunning: this.isRunning(dep) }
			})
			.filter(Boolean) as Array<{ name: string; isRunning: boolean }>
	}

	getPluginSchema(target: PluginConstructor | string) {
		const ctor = this.resolveRuntimeCtor(target)
		if (ctor === undefined) return
		return this.registry.getSchema(ctor)
	}

	buildSnapshot(): string {
		return buildSnapshotSource({
			ctx: this.ctx,
			registry: this.registry,
			isRunning: (target) => this.isRunning(target),
		})
	}

	private deriveLifecycleStage(isRunning: boolean, isEnabled: boolean): PluginLifecycleStage {
		if (!isEnabled) return 'disabled'
		return isRunning ? 'running' : 'stopped'
	}
}
