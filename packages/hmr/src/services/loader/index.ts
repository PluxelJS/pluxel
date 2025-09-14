// loader/index.ts
import {
	type Context,
	getClassParam,
	getOptionalPredicate,
	getPluginInfo,
	Injectable,
	type PluginConstructor,
} from '@pluxel/core'
import { genObjectFromRawEntries, genObjectFromValues } from 'knitwork'
import { PluginRegistry } from './PluginRegistry'

const serviceName = 'loader' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: LoaderService
	}
}

@Injectable({ key: serviceName })
export class LoaderService {
	public registry: PluginRegistry
	public pathAnchors = new Set<string>()
	private hmrBound = new Set<string>()

	constructor(private ctx: Context) {
		// 启动前把有效配置注入实例（valibot 已校验 & 默认值补齐）
		this.ctx.on('beforeStart', (plugin) => {
			const ctor = plugin.constructor as PluginConstructor
			const schemaMap = this.registry.getSchema(ctor)
			if (!schemaMap) return
			const name = plugin.ctx.pluginInfo.meta.name
			const { configRecord } = plugin.ctx.configService.getConfig(name)
			for (const key of Object.keys(schemaMap)) {
				;(plugin as any)[key] = (configRecord as any)[key]
			}
		})

		// 原子提交失败，回滚运行态（不改配置）
		this.ctx.on('commitFailed', (failed) => {
			for (const pCtor of failed) {
				const name = getPluginInfo(pCtor as PluginConstructor)!.meta.name
				this.registry.deactivate(name, pCtor as PluginConstructor, { runtimeOnly: true })
			}
		})

		this.registry = new PluginRegistry(this.ctx)
	}

	/** 装载某个文件模块（首载/HMR 更新共用） */
	loadFileModule(moduleId: string, mod: Record<string, unknown>): boolean {
		// 先卸载旧的（仅运行态）
		this.registry.unregister(moduleId, { runtimeOnly: true })

		let isPlugin = false
		for (const [exportKey, exp] of Object.entries(mod)) {
			if (typeof exp !== 'function') continue
			if (!getPluginInfo(exp)) continue
			this.registry.register(moduleId, exp as PluginConstructor, exportKey) // 记录导出键
			isPlugin = true
		}

		if (isPlugin) this.pathAnchors.add(moduleId)
		else this.pathAnchors.delete(moduleId)

		if (import.meta.hot && !this.hmrBound.has(moduleId)) {
			this.hmrBound.add(moduleId)
			import.meta.hot.accept((newMod) => this.loadFileModule(moduleId, newMod as any))
			import.meta.hot.dispose(() => {
				this.registry.unregister(moduleId, { runtimeOnly: true })
				this.hmrBound.delete(moduleId)
			})
		}

		return isPlugin
	}

	getLoadedPluginsName(): string[] {
		return this.registry.getLoadedNames()
	}

	getFullPluginStatus() {
		const loaded = this.registry.names
		const statuses: Record<string, { id: string; isRunning: boolean }> = Object.create(null)
		let running = 0
		let stopped = 0

		for (const [name, ctor] of loaded) {
			const isRunning = this.ctx.registry.isRunning(ctor)
			statuses[name] = { id: name, isRunning }
			if (isRunning) running++
			else stopped++
		}

		return { statuses, summary: { total: running + stopped, running, stopped } }
	}

	getPluginDependenciesInfo(ctor: PluginConstructor) {
		const predicate = getOptionalPredicate(ctor)
		return getClassParam<PluginConstructor>(ctor)
			.map((dep, i) => {
				const info = getPluginInfo(dep)
				if (!info) return undefined
				return {
					name: info.meta.name,
					optional: predicate.isOptional(i),
					isRunning: this.ctx.registry.isRunning(dep),
				}
			})
			.filter(Boolean) as Array<{ name: string; optional: boolean; isRunning: boolean }>
	}

	getPluginClassByName(name: string) {
		return this.registry.getPluginByName(name)
	}

	getPluginSchema(ctor: PluginConstructor) {
		return this.registry.getSchema(ctor)
	}

	/**
	 * 极简快照输出：
	 * - 只包含“当前正在运行”的插件
	 * - 导出：按文件 re-export（IDE 可跳转）
	 * - 主对象：registry = { [pluginName]: { ctor, config } }
	 * - 配置序列化：genObjectFromValues（数组/嵌套稳定）
	 *
	 * @returns TypeScript 源码字符串
	 */
	buildSnapshot(): string {
		type Row = {
			name: string
			moduleId: string
			exportKey: string
			alias: string
		}

		const rows: Row[] = []
		for (const [name, ctor] of this.registry.names) {
			if (!this.ctx.registry.isRunning(ctor)) continue
			const moduleId = this.registry.name2PathMap.get(name)
			const exportKey = this.registry.getExportKeyByName(name)
			if (!moduleId || !exportKey) continue
			rows.push({ name, moduleId, exportKey, alias: this.aliasFor(name) })
		}

		// 稳定排序，保证别名冲突时的决策可重复
		rows.sort((a, b) => (a.name === b.name ? a.moduleId.localeCompare(b.moduleId) : a.name.localeCompare(b.name)))

		// 确保别名唯一：如发生碰撞，则追加“文件基名/导出键”，再退化数字后缀
		const used = new Set<string>()
		for (const r of rows) {
			let alias = r.alias
			if (!used.has(alias)) {
				used.add(alias)
				r.alias = alias
				continue
			}
			// 1) 加文件基名（更具可读性 & 稳定）
			const withFile = `${alias}__${this.basenameFor(r.moduleId)}`
			if (!used.has(withFile)) {
				used.add(withFile)
				r.alias = withFile
				continue
			}
			// 2) 再加导出键
			const keySuffix = r.exportKey === 'default' ? 'default' : this.safeIdent(r.exportKey)
			const withKey = `${withFile}__${keySuffix}`
			if (!used.has(withKey)) {
				used.add(withKey)
				r.alias = withKey
				continue
			}
			// 3) 最后数字退化，保证唯一
			let i = 2
			while (used.has(`${withKey}__${i}`)) i++
			const finalAlias = `${withKey}__${i}`
			used.add(finalAlias)
			r.alias = finalAlias
		}

		const header =
			'// @generated by LoaderService.buildSnapshot\n' +
			`// ${new Date().toISOString()}\n` +
			'/* eslint-disable */\n'

		// 1) import + re-export（一个模块一行，支持 default / 命名导出）
		const grouped = new Map<string, Row[]>()
		for (const r of rows) {
			const list = grouped.get(r.moduleId) ?? []
			list.push(r)
			grouped.set(r.moduleId, list)
		}

		const importLines: string[] = []
		const exportAliases = new Set<string>()
		for (const [moduleId, list] of grouped) {
			// import：确保下面 registry 里能引用到别名符号
			const defaultItem = list.find((e) => e.exportKey === 'default')
			const namedItems = list.filter((e) => e.exportKey !== 'default')
			if (defaultItem && namedItems.length > 0) {
				const namedPart = namedItems.map((e) => `${e.exportKey} as ${e.alias}`).join(', ')
				importLines.push(`import ${defaultItem.alias}, { ${namedPart} } from ${JSON.stringify(moduleId)};`)
			} else if (defaultItem) {
				importLines.push(`import ${defaultItem.alias} from ${JSON.stringify(moduleId)};`)
			} else if (namedItems.length > 0) {
				const namedPart = namedItems.map((e) => `${e.exportKey} as ${e.alias}`).join(', ')
				importLines.push(`import { ${namedPart} } from ${JSON.stringify(moduleId)};`)
			}

			// 收集将要导出的本地别名（不再使用 from ... 形式，避免重复模块说明）
			for (const e of list) exportAliases.add(e.alias)
		}

		// 2) registry = { name: { ctor: Alias, config: {...} } }
		const entries: [string, string][] = rows.map((r) => {
			const { configRecord } = this.ctx.configService.getConfig(r.name)
			const cfg = genObjectFromValues(stripUndef(configRecord)) // ✅ 数组/嵌套安全
			// 值是“原样字符串”，包含标识符和已序列化的字面量
			const valCode = `{ ctor: ${r.alias}, config: ${cfg} }`
			return [r.name, valCode] // ⚠️ key 传原始 name，knitwork 会自动按需加引号
		})
		const registryCode = genObjectFromRawEntries(entries)

		const exportLine = `export { ${[...exportAliases].join(', ')} };`
		const body = `export const registry = ${registryCode} as const;\n \n    export type PluginName = keyof typeof registry;\n`
		return [header, ...importLines, '', exportLine, '', body].join('\n')
	}

	// —— 辅助 —— //
	private aliasFor(name: string): string {
		let id = 'P_' + name.replace(/[^A-Za-z0-9_$]/g, '_')
		if (/^[0-9]/.test(id)) id = '_' + id
		return id
	}

	private basenameFor(path: string): string {
		const normalized = path.replace(/\\/g, '/')
		const last = normalized.split('/').pop() || ''
		const stem = last.replace(/\.[A-Za-z0-9]+$/, '')
		return this.safeIdent(stem)
	}

	private safeIdent(s: string): string {
		let id = s.replace(/[^A-Za-z0-9_$]/g, '_')
		if (/^[0-9]/.test(id)) id = '_' + id
		return id
	}
}

// 清除 undefined，保证 genObjectFromValues 输出稳定（数组/对象均保留）
function stripUndef<T>(obj: T): T {
	if (obj == null || typeof obj !== 'object') return obj
	if (Array.isArray(obj)) return obj.map(stripUndef) as unknown as T
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj as any)) {
		if (v === undefined) continue
		out[k] = stripUndef(v as any)
	}
	return out as T
}
