// loader/PluginRegistry.ts
import { type Context, getPluginInfo, type PluginConstructor } from '@pluxel/core'
import { getDefault, safeParse } from 'valibot'
import type { ConfigSchemaMap } from '../..'

type ModuleId = string
type PluginName = string
type ExportKey = string
type ModuleItem = Readonly<{ ctor: PluginConstructor; exportKey: ExportKey }>

const EMPTY: readonly ModuleItem[] = Object.freeze([])
export const LIFECYCLE_STATES = ['running', 'stopped', 'disabled'] as const
export type PluginLifecycleStage = (typeof LIFECYCLE_STATES)[number]

export interface PluginLifecycleSnapshot {
	id: string
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: PluginLifecycleStage
}

export class PluginRegistry {
	// 声明层
	private moduleMap = new Map<ModuleId, readonly ModuleItem[]>() // 模块 -> [{ ctor, exportKey }]
	private nameMap = new Map<PluginName, PluginConstructor>() // 名称 -> ctor
	private name2Path = new Map<PluginName, ModuleId>() // 名称 -> 文件
	private name2ExportKey = new Map<PluginName, ExportKey>() // 名称 -> 导出键
	private enrolled = new WeakMap<PluginConstructor, Set<ModuleId>>() // 模块级去重

	constructor(private ctx: Context) {}

	// ---------- 只读 ----------
	get modules(): ReadonlyMap<ModuleId, readonly ModuleItem[]> {
		return this.moduleMap
	}
	get names(): ReadonlyMap<PluginName, PluginConstructor> {
		return this.nameMap
	}
	get name2PathMap(): ReadonlyMap<PluginName, ModuleId> {
		return this.name2Path
	}

	getLoadedNames(): string[] {
		return [...this.nameMap.keys()].sort()
	}
	getPluginByName(name: string): PluginConstructor | undefined {
		return this.nameMap.get(name)
	}
	getSchema(ctor: PluginConstructor): ConfigSchemaMap | undefined {
		return getPluginInfo(ctor)?.configMap
	}
	getExportKeyByName(name: string): ExportKey | undefined {
		return this.name2ExportKey.get(name)
	}

	// =============== 声明层：落/撤 ===============
	declarePlugin(moduleId: ModuleId, ctor: PluginConstructor, exportKey: ExportKey): void {
		const { name } = getPluginInfo(ctor)

		// 冲突：允许“同路径热替换”，拒绝“跨路径重名”
		const existed = this.nameMap.get(name)
		const existedPath = this.name2Path.get(name)
		if (existed && existed !== ctor && existedPath && existedPath !== moduleId) {
			throw new Error(`插件名冲突：${name} 已由 ${existedPath} 提供，拒绝来自 ${moduleId}`)
		}

		const seen = this.enrolled.get(ctor) ?? new Set<ModuleId>()
		if (seen.has(moduleId)) return
		seen.add(moduleId)
		this.enrolled.set(ctor, seen)

		const prev = this.moduleMap.get(moduleId) ?? EMPTY
		if (!prev.some((i) => i.ctor === ctor)) {
			this.moduleMap.set(moduleId, Object.freeze([...prev, Object.freeze({ ctor, exportKey })]))
		}

		this.nameMap.set(name, ctor)
		this.name2Path.set(name, moduleId)
		this.name2ExportKey.set(name, exportKey)
	}

	/** 清空模块的声明（通常在 replace/prune 前调用） */
	undeclareModule(moduleId: ModuleId): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const item of list) {
			const ctor = item.ctor
			const { name } = getPluginInfo(ctor)

			// 仅当映射仍指向该 moduleId 才移除（避免其他路径已重建时误删）
			if (this.name2Path.get(name) === moduleId) {
				this.nameMap.delete(name)
				this.name2Path.delete(name)
				this.name2ExportKey.delete(name)
			}
			const seen = this.enrolled.get(ctor)
			if (seen) {
				seen.delete(moduleId)
				if (seen.size === 0) this.enrolled.delete(ctor)
			}
		}
		this.moduleMap.delete(moduleId)
	}

	// =============== 运行层：启/停 ===============
	/** 根据 config 启用位，为该模块内需要启用的插件执行 start */
	syncRuntimeForModule(moduleId: ModuleId): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const { ctor } of list) {
			const { name } = getPluginInfo(ctor)
			if (this.ctx.configService.isEnable(name)) {
				this.startPlugin(name, ctor)
			}
		}
	}

	enable(name: PluginName, ctor: PluginConstructor): void {
		this.startPlugin(name, ctor)
	}

	startPlugin(name: PluginName, ctor: PluginConstructor): void {
		// 配置校验/补齐（幂等）
		const schema = this.getSchema(ctor)
		if (schema) {
			const { configRecord } = this.ctx.configService.getConfig(name)
			const patch: Record<string, unknown> = Object.create(null)
			for (const [k, vSchema] of Object.entries(schema)) {
				const cur = (configRecord as any)[k]
				const val = cur === undefined ? getDefault(vSchema) : cur
				const res = safeParse(vSchema as any, val)
				if (!res.success) {
					const issue = res.issues[0]
					const where = issue?.path?.map((p: any) => p.key ?? p.index).join('.') || k
					throw new Error(`插件 ${name} 配置无效：${where} -> ${issue?.message ?? 'unknown'}`)
				}
				if (cur === undefined) patch[k] = val
			}
			if (Object.keys(patch).length > 0) {
				this.ctx.configService.setConfig(name, patch)
			}
		}

		// 进入运行层（两段式，失败回滚）
		let enabled = false
		try {
			if (!this.ctx.configService.isEnable(name)) {
				this.ctx.configService.enablePlugin(name)
			}
			enabled = true
			this.ctx.registry.pluginRegistry.registerPlugin(ctor)
		} catch (err) {
			// 回滚
			this.logGuard(`core.unregister(${name})`, () => {
				this.ctx.registry.pluginRegistry.unregisterPlugin(ctor)
			})
			if (enabled) {
				this.logGuard(`config.disable(${name})`, () => {
					this.ctx.configService.disablePlugin(name)
				})
			}
			throw err
		}
	}

	/** 只停运行层（保留 config 启用位） */
	stopPlugin(name: PluginName, ctor: PluginConstructor): void {
		this.logGuard(`core.unregister(${name})`, () => {
			this.ctx.registry.pluginRegistry.unregisterPlugin(ctor)
		})
	}

	deactivate(
		name: PluginName,
		ctor: PluginConstructor,
		options: { runtimeOnly?: boolean } = {},
	): void {
		this.stopPlugin(name, ctor)
		if (!options.runtimeOnly) {
			this.disablePersisted(name)
		}
	}

	/** 停止某模块内全部插件（只影响运行层） */
	stopModule(moduleId: ModuleId): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const { ctor } of list) {
			const { name } = getPluginInfo(ctor)
			this.stopPlugin(name, ctor)
		}
	}

	// =============== 持久层（配置启用位） ===============
	enablePersisted(...names: readonly string[]): void {
		this.ctx.configService.enablePlugin(...names)
	}
	disablePersisted(...names: readonly string[]): void {
		this.ctx.configService.disablePlugin(...names)
	}
	/** 将该模块内所有插件的持久启用位关闭（用于 prune(persisted)） */
	disablePersistedByModule(moduleId: ModuleId): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const { ctor } of list) {
			const { name } = getPluginInfo(ctor)
			this.disablePersisted(name)
		}
	}

	// --------------- 工具 ---------------
	private logGuard(label: string, fn: () => void) {
		try {
			fn()
		} catch (err) {
			this.ctx.logger?.warn({ err, label }, `[PluginRegistry] 可恢复异常：${label}`)
		}
	}
}
