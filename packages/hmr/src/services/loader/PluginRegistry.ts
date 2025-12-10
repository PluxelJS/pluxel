// loader/PluginRegistry.ts
import {
	type Context,
	getDeclaredName,
	getPluginInfo,
	type PluginConstructor,
	setPluginIdentity,
} from '@pluxel/core'
import { dirname, normalize } from 'pathe'
import * as v from 'valibot'
import type { ConfigSchemaMap } from '../..'

type ModuleId = string
type PluginName = string
type ExportKey = string
type ModuleItem = Readonly<{ ctor: PluginConstructor; exportKey: ExportKey }>

const EMPTY: readonly ModuleItem[] = Object.freeze([])
const isIndexFile = (p: string) => /(?:^|\/)index\.[cm]?[tj]sx?$/.test(p)
const sameDir = (a: string, b: string) => dirname(normalize(a)) === dirname(normalize(b))
export const LIFECYCLE_STATES = ['running', 'stopped', 'disabled'] as const
export type PluginLifecycleStage = (typeof LIFECYCLE_STATES)[number]

/**
 * 从模块路径提取包名
 * e.g., "/path/node_modules/pkg-a/dist/plugin.js" -> "pkg-a"
 * e.g., "/path/node_modules/@scope/pkg/index.js" -> "@scope/pkg"
 * e.g., "/project/src/plugins/foo.ts" -> null (本地文件，无包名)
 */
function extractPackageName(moduleId: string): string | null {
	const match = moduleId.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
	return match?.[1] ?? null
}

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

	private isPrimaryProvider(moduleId: ModuleId, ctor: PluginConstructor): boolean {
		const { id: name } = getPluginInfo(ctor)
		const primary = this.name2Path.get(name)
		return primary === undefined || primary === moduleId
	}

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
	getSchemaSource(ctor: PluginConstructor): Readonly<Record<string, string>> | undefined {
		return getPluginInfo(ctor)?.configSourceMap
	}
	getExportKeyByName(name: string): ExportKey | undefined {
		return this.name2ExportKey.get(name)
	}

	// =============== 声明层：落/撤 ===============
	declarePlugin(moduleId: ModuleId, ctor: PluginConstructor, exportKey: ExportKey): void {
		const declaredName = getDeclaredName(ctor)
		let { id: name } = getPluginInfo(ctor)

		// 冲突：允许"同路径热替换"，拒绝"跨路径重名"
		const existed = this.nameMap.get(name)
		const existedPath = this.name2Path.get(name)
		const enrolledPaths = existed ? this.enrolled.get(existed) : undefined
		const isKnownAlias = enrolledPaths?.has(moduleId)
		const existingIsIndexAlias =
			existedPath &&
			existedPath !== moduleId &&
			isIndexFile(existedPath) &&
			sameDir(existedPath, moduleId)
		const candidateIsIndexAlias =
			existedPath &&
			existedPath !== moduleId &&
			isIndexFile(moduleId) &&
			sameDir(existedPath, moduleId)

		// 若原主提供者是 index.*，让位给同目录的真实文件前，先停掉旧运行态以避免双注册
		if (existingIsIndexAlias && !candidateIsIndexAlias) {
			this.stopPlugin(name, existed!)
		}

		// 检测真正的冲突
		const isConflict =
			existed &&
			existed !== ctor &&
			existedPath &&
			existedPath !== moduleId &&
			!isKnownAlias &&
			!existingIsIndexAlias &&
			!candidateIsIndexAlias

		if (isConflict) {
			// 尝试自动解决：给后来者添加包名前缀
			const pkgName = extractPackageName(moduleId)
			if (pkgName === null) {
				throw new Error(`插件名冲突：${name} 已由 ${existedPath} 提供，拒绝来自 ${moduleId}`)
			}
			const prefixedId = `${pkgName}/${declaredName}`
			// 检查前缀后是否仍然冲突
			if (this.nameMap.has(prefixedId)) {
				throw new Error(
					`插件名冲突：${name} 已由 ${existedPath} 提供，` +
						`尝试使用 ${prefixedId} 仍然冲突，拒绝来自 ${moduleId}`,
				)
			}
			// 设置新的 id 和包名
			setPluginIdentity(ctor, { id: prefixedId, packageName: pkgName })
			name = prefixedId
			this.ctx.logger?.info(
				`[PluginRegistry] 插件 "${declaredName}" 来自包 ${pkgName}，已自动重命名为 "${prefixedId}"`,
			)
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
		// 避免被“同 ctor 的跨路径再导出”覆盖掉首个声明的主路径；除非要把 index.* 别名让位给真实文件
		const shouldUpdatePrimaryMapping =
			(!existedPath || existedPath === moduleId || existed !== ctor || existingIsIndexAlias) &&
			!candidateIsIndexAlias
		if (shouldUpdatePrimaryMapping) {
			this.name2Path.set(name, moduleId)
			this.name2ExportKey.set(name, exportKey)
		}
	}

	/** 清空模块的声明（通常在 replace/prune 前调用） */
	undeclareModule(moduleId: ModuleId): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const item of list) {
			const ctor = item.ctor
			const { id: name } = getPluginInfo(ctor)

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
	async syncRuntimeForModule(moduleId: ModuleId): Promise<void> {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		// 并行启动（registerPlugin 只是声明，依赖处理在 commit 时）
		const toStart = list.flatMap(({ ctor }) => {
			const { id: name } = getPluginInfo(ctor)
			if (!this.isPrimaryProvider(moduleId, ctor) || !this.ctx.configService.isEnable(name))
				return []
			return [this.startPlugin(name, ctor)]
		})
		if (toStart.length > 0) await Promise.all(toStart)
	}

	async enable(name: PluginName, ctor: PluginConstructor): Promise<void> {
		await this.startPlugin(name, ctor)
	}

	async startPlugin(name: PluginName, ctor: PluginConstructor): Promise<void> {
		// 配置校验/补齐（幂等）
		const schema = this.getSchema(ctor)
		if (schema) {
			const { configRecord } = this.ctx.configService.getConfig(name)
			const entries = Object.entries(schema)
			const hasAsync = entries.some(([, s]) => s.async)

			const patch: Record<string, unknown> = Object.create(null)
			const handleResult = (k: string, cur: unknown, res: v.SafeParseResult<any>) => {
				if (!res.success) {
					const issue = res.issues[0]
					const where = issue?.path?.map((p: any) => p.key ?? p.index).join('.') || k
					throw new Error(`插件 ${name} 配置无效：${where} -> ${issue?.message ?? 'unknown'}`)
				}
				if (cur === undefined && res.output !== undefined) patch[k] = res.output
			}

			if (!hasAsync) {
				// 快速同步路径
				for (const [k, vSchema] of entries) {
					const cur = (configRecord as any)[k]
					const candidate =
						cur === undefined
							? (v.getDefault(vSchema as any) ?? (this.isObjectSchema(vSchema) ? {} : undefined))
							: cur
					handleResult(k, cur, v.safeParse(vSchema as any, candidate))
				}
			} else {
				// 异步路径：并行处理
				const results = await Promise.all(
					entries.map(async ([k, vSchema]) => {
						const cur = (configRecord as any)[k]
						const defaultVal = v.getDefault(vSchema as any)
						const candidate =
							cur === undefined
								? (defaultVal ?? (this.isObjectSchema(vSchema) ? {} : undefined))
								: cur
						const res = vSchema.async
							? await v.safeParseAsync(vSchema as any, candidate)
							: v.safeParse(vSchema as any, candidate)
						return { k, cur, res }
					}),
				)
				for (const { k, cur, res } of results) handleResult(k, cur, res)
			}

			if (Object.keys(patch).length > 0) {
				this.ctx.configService.setConfig(name, { configRecord: patch })
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
			const { id: name } = getPluginInfo(ctor)
			if (!this.isPrimaryProvider(moduleId, ctor)) continue
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
			const { id: name } = getPluginInfo(ctor)
			if (!this.isPrimaryProvider(moduleId, ctor)) continue
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

	private isObjectSchema(schema: unknown): boolean {
		return (schema as { type?: string })?.type === 'object'
	}
}
