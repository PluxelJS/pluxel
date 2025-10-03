// loader/PluginRegistry.ts
import { type Context, getPluginInfo, type PluginConstructor } from '@pluxel/core'
import { getDefault, safeParse } from 'valibot'
import type { ConfigSchemaMap } from '../..'

type ModuleId = string
type PluginName = string
type ExportKey = string

type ModuleItem = Readonly<{
	ctor: PluginConstructor
	exportKey: ExportKey
}>

const EMPTY: readonly ModuleItem[] = Object.freeze([])

export class PluginRegistry {
	private moduleMap = new Map<ModuleId, readonly ModuleItem[]>() // 模块 -> [{ ctor, exportKey }]
	private nameMap = new Map<PluginName, PluginConstructor>() // 名称 -> ctor
	private name2Path = new Map<PluginName, ModuleId>() // 名称 -> 文件
	private name2ExportKey = new Map<PluginName, ExportKey>() // 名称 -> 导出键（含 default）
	private enrolled = new WeakMap<PluginConstructor, Set<ModuleId>>() // 去重（模块级）

	constructor(private ctx: Context) {}

	// —— 只读视图 —— //
	get modules(): ReadonlyMap<ModuleId, readonly ModuleItem[]> {
		return this.moduleMap
	}
	get name2PathMap(): ReadonlyMap<PluginName, ModuleId> {
		return this.name2Path
	}
	get names(): ReadonlyMap<PluginName, PluginConstructor> {
		return this.nameMap
	}

	// —— 核心 API：登记/撤销（不带“策略”） —— //
	register(moduleId: ModuleId, ctor: PluginConstructor, exportKey: ExportKey): void {
		const info = getPluginInfo(ctor)
		if (!info) throw new Error('缺少 @Plugin 装饰器元数据')
		const name = info.meta.name as PluginName

		const existed = this.nameMap.get(name)
		if (existed && existed !== ctor) {
			const path = this.name2Path.get(name)
			throw new Error(`插件名冲突：${name} 已由模块 ${path} 提供，拒绝来自 ${moduleId} 的重复声明`)
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

		// 仅当用户已开启时才启用；策略（默认补齐 + 校验 + 原子写入）在内部做，但无 reload。
		if (this.ctx.configService.isEnable(name)) {
			try {
				this.enable(name, ctor)
			} catch (e) {
				this.ctx.logger.error(e, `插件 ${name} 启用失败.`)
				this.deactivate(name, ctor, { runtimeOnly: false })
			}
		}
	}

	unregister(moduleId: ModuleId, { runtimeOnly = true }: { runtimeOnly?: boolean } = {}): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		if (list.length === 0) {
			this.moduleMap.delete(moduleId)
			return
		}
		for (const item of list) {
			const ctor = item.ctor
			const info = getPluginInfo(ctor)!
			const name = info.meta.name as PluginName
			this.deactivate(name, ctor, { runtimeOnly })
			this.nameMap.delete(name)
			this.name2Path.delete(name)
			this.name2ExportKey.delete(name)
			const seen = this.enrolled.get(ctor)
			if (seen) {
				seen.delete(moduleId)
				if (seen.size === 0) this.enrolled.delete(ctor)
			}
		}
		this.moduleMap.delete(moduleId)
	}

	// —— 公共：启用/停用（供 LoaderService/外部策略调用） —— //
	enable(name: PluginName, ctor: PluginConstructor): void {
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

		// 启用 + 核心注册；失败可观测 + 回滚
		let enabled = false
		try {
			this.ctx.configService.enablePlugin(name)
			enabled = true
			this.ctx.registry.pluginRegistry.registerPlugin(ctor)
		} catch (err) {
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

	/** 公开的“停用”桥（替代 private disablePlugin） */
	deactivate(
		name: PluginName,
		ctor: PluginConstructor,
		{ runtimeOnly = true }: { runtimeOnly?: boolean } = {},
	): void {
		this.logGuard(`core.unregister(${name})`, () => {
			this.ctx.registry.pluginRegistry.unregisterPlugin(ctor)
		})
		// 默认仍会关“当前启用位”；如需热更后自动复活，可在调用处传 { runtimeOnly: false } 并调整实现
		if (runtimeOnly === false) {
			this.logGuard(`config.disable(${name})`, () => {
				this.ctx.configService.disablePlugin(name)
			})
		}
	}

	// —— 查询 —— //
	getLoadedNames(): string[] {
		return [...this.nameMap.keys()].sort()
	}
	getPluginByName(name: string): PluginConstructor | undefined {
		return this.nameMap.get(name)
	}
	getSchema(ctor: PluginConstructor): ConfigSchemaMap | undefined {
		return getPluginInfo(ctor)?.configMap // 你内部已有 WeakMap 缓存
	}
	getExportKeyByName(name: string): ExportKey | undefined {
		return this.name2ExportKey.get(name)
	}

	private logGuard(label: string, fn: () => void) {
		try {
			fn()
		} catch (err) {
			this.ctx.logger?.warn({ err, label }, `[PluginRegistry] 可恢复异常：${label}`)
		}
	}
}
