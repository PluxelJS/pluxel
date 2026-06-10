// loader/PluginRegistry.ts
import {
	type ConfigLayout,
	type Context,
	type ForkablePluginConstructor,
	formatForkPluginId,
	getDeclaredName,
	getForkOf,
	isForkPluginId,
	getPluginInfo,
	type PluginConstructor,
	type PluginIdentifier,
	setPluginIdentity,
} from '@pluxel/core'
import {
	type ConfigSchemaMap as CoreConfigSchemaMap,
	isStandardSchemaV1,
} from '@pluxel/core/services'
import * as v from 'valibot'
import {
	type BaseProvidersExtra,
	EXTRA_BASE_PROVIDERS,
	EXTRA_FORKS,
	type ForksExtra,
} from './selection'

type ModuleId = string
type PluginName = string
type ExportKey = string
type ModuleItem = Readonly<{ ctor: PluginConstructor; exportKey: ExportKey }>

const EMPTY: readonly ModuleItem[] = []
const isIndexFile = (p: string) => /(?:^|[\\/])index\.[cm]?[tj]sx?$/.test(p)
const sameDir = (a: string, b: string) => {
	// Hot path: HMR-normalized ids are posix paths without traversal segments.
	// Avoid `pathe.normalize/dirname` in the common case.
	const ai = a.lastIndexOf('/')
	const bi = b.lastIndexOf('/')
	if (ai > 0 && bi > 0 && !a.includes('\\') && !b.includes('\\')) {
		return a.slice(0, ai) === b.slice(0, bi)
	}

	const na = a.includes('\\') ? a.replaceAll('\\', '/') : a
	const nb = b.includes('\\') ? b.replaceAll('\\', '/') : b
	const nai = na.lastIndexOf('/')
	const nbi = nb.lastIndexOf('/')
	if (nai === -1 || nbi === -1) return false
	return na.slice(0, nai) === nb.slice(0, nbi)
}
export const LIFECYCLE_STATES = ['running', 'stopped', 'disabled'] as const
export type PluginLifecycleStage = (typeof LIFECYCLE_STATES)[number]

/**
 * 从模块路径提取包名
 * e.g., "/path/node_modules/pkg-a/dist/plugin.js" -> "pkg-a"
 * e.g., "/path/node_modules/@scope/pkg/index.js" -> "@scope/pkg"
 * e.g., "/project/src/plugins/foo.ts" -> null (本地文件，无包名)
 */
function extractPackageName(moduleId: string): string | null {
	const match = moduleId.match(/node_modules[\\/](?:@[^/\\]+[\\/][^/\\]+|[^/\\]+)/)
	if (!match) return null
	const seg = match[0]
	const cleaned = seg.replace(/^.*node_modules[\\/]/, '')
	if (cleaned.startsWith('@')) {
		const parts = cleaned.split(/[\\/]/).filter(Boolean)
		const scoped = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : cleaned
		return scoped || null
	}
	return cleaned.split(/[\\/]/)[0] ?? null
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

	private getForkIds(originalName: string): string[] {
		const map = this.ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS)
		const list = map?.[originalName]
		if (!Array.isArray(list) || list.length === 0) return []
		const out: string[] = []
		for (const id of list) {
			const forkId = typeof id === 'string' ? id.trim() : ''
			if (forkId) out.push(forkId)
		}
		return out
	}

	private recordBaseProvider(baseToken: PluginIdentifier, providerName: string) {
		const baseKey = getDeclaredName(baseToken)
		const prev = this.ctx.configService.getExtra<BaseProvidersExtra>(EXTRA_BASE_PROVIDERS) ?? {}
		if (prev[baseKey] === providerName) return
		this.ctx.configService.setExtra(EXTRA_BASE_PROVIDERS, {
			...prev,
			[baseKey]: providerName,
		})
	}

	/* ----------------------------- Transaction ----------------------------- */
	/**
	 * Loader 内部事务（仅保护 loader 的声明层状态）。
	 *
	 * 说明：
	 * - core 的 DI 草稿回滚由 `ctx.registry.resetDraft()`/commit 内部负责；
	 * - 这里仅保证「模块声明层」与「name->ctor 映射」在 commit(含 build 校验)失败时可恢复，
	 *   避免 loader 与 core 的容器状态出现漂移。
	 *
	 * 性能：只记录变更 key 的旧值（O(变更)），不 clone 全表（O(插件总数)）。
	 */
	public beginTransaction() {
		type Undo = () => void
		const undos: Undo[] = []
		const seen = new Map<object, Set<unknown>>() // map -> keys

		const record = <K, V>(map: Map<K, V>, key: K) => {
			let keys = seen.get(map as unknown as object)
			if (!keys) {
				keys = new Set()
				seen.set(map as unknown as object, keys)
			}
			if (keys.has(key)) return
			keys.add(key)
			const had = map.has(key)
			const prev = map.get(key)
			undos.push(() => {
				if (!had) map.delete(key)
				else map.set(key, prev as V)
			})
		}

		const recordWeak = <K extends object, V>(wm: WeakMap<K, V>, key: K) => {
			let keys = seen.get(wm as unknown as object)
			if (!keys) {
				keys = new Set()
				seen.set(wm as unknown as object, keys)
			}
			if (keys.has(key)) return
			keys.add(key)
			const had = wm.has(key)
			const prev = wm.get(key)
			undos.push(() => {
				if (!had) wm.delete(key)
				else wm.set(key, prev)
			})
		}

		const recordIdentity = (ctor: PluginConstructor) => {
			// identity is stored in @pluxel/core decorator state; treat it as part of loader state.
			let keys = seen.get(ctor)
			if (!keys) {
				keys = new Set()
				seen.set(ctor, keys)
			}
			if (keys.has('__identity__')) return
			keys.add('__identity__')
			const info = getPluginInfo(ctor)
			const prev = {
				id: info.id,
				displayName: info.displayName ?? null,
				packageName: info.packageName ?? null,
			}
			undos.push(() => {
				setPluginIdentity(ctor, prev)
			})
		}

		return {
			recordModule: (moduleId: ModuleId) => record(this.moduleMap, moduleId),
			recordName: (name: PluginName) => {
				record(this.nameMap, name)
				record(this.name2Path, name)
				record(this.name2ExportKey, name)
			},
			recordEnrolled: (ctor: PluginConstructor) => recordWeak(this.enrolled, ctor),
			recordIdentity,
			rollback: () => {
				for (let i = undos.length - 1; i >= 0; i--) undos[i]!()
			},
			commit: () => {
				undos.length = 0
				seen.clear()
			},
		}
	}

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
	getSchema(ctor: PluginConstructor): CoreConfigSchemaMap | undefined {
		const info = getPluginInfo(ctor)
		const map = info?.configMap as Record<string, unknown> | null | undefined
		if (!map) return undefined

		for (const [key, schema] of Object.entries(map)) {
			if (!isStandardSchemaV1(schema) || !v.isOfType('object', schema as any)) {
				throw new Error(
					`Invalid config schema: "${info.id}.${key}" must be a valibot ObjectSchema (use v.object(...) / v.objectAsync(...)).`,
				)
			}
		}

		return map as unknown as CoreConfigSchemaMap
	}
	getSchemaSource(ctor: PluginConstructor): Readonly<Record<string, string>> | undefined {
		return getPluginInfo(ctor)?.configSourceMap
	}
	getConfigLayout(ctor: PluginConstructor): Readonly<Record<string, ConfigLayout>> | undefined {
		return getPluginInfo(ctor)?.configLayoutMap ?? undefined
	}
	getExportKeyByName(name: string): ExportKey | undefined {
		return this.name2ExportKey.get(name)
	}

	listModuleItems(moduleId: ModuleId): readonly ModuleItem[] {
		return this.moduleMap.get(moduleId) ?? EMPTY
	}

	// =============== 声明层：落/撤 ===============
	declarePlugin(
		moduleId: ModuleId,
		ctor: PluginConstructor,
		exportKey: ExportKey,
		tx?: ReturnType<PluginRegistry['beginTransaction']>,
	): PluginName {
		tx?.recordModule(moduleId)
		const declaredName = getDeclaredName(ctor)
		let { id: name } = getPluginInfo(ctor)
		tx?.recordName(name)

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
				const extra =
					existedPath === 'pluxel:builtins'
						? '（提示：你启用了 builtins 且扫描范围可能包含同一插件源码；请用 loaderHmr.exclude 排除该插件目录，或移除 builtins 配置以避免重复加载）'
						: ''
				throw new Error(
					`插件名冲突：${name} 已由 ${existedPath} 提供，拒绝来自 ${moduleId}${extra}`,
				)
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
			tx?.recordName(prefixedId)
			tx?.recordIdentity(ctor)
			setPluginIdentity(ctor, { id: prefixedId, packageName: pkgName })
			name = prefixedId
			this.ctx.logger
				.info`[PluginRegistry] 插件 "${declaredName}" 来自包 ${pkgName}，已自动重命名为 "${prefixedId}"`
		}

		const prevSeen = this.enrolled.get(ctor)
		if (prevSeen?.has(moduleId)) return name
		if (tx) {
			tx.recordEnrolled(ctor)
			const next = prevSeen ? new Set(prevSeen) : new Set<ModuleId>()
			next.add(moduleId)
			this.enrolled.set(ctor, next)
		} else {
			const seen = prevSeen ?? new Set<ModuleId>()
			seen.add(moduleId)
			this.enrolled.set(ctor, seen)
		}

		const prev = this.moduleMap.get(moduleId) ?? EMPTY
		let alreadyDeclared = false
		for (let i = 0; i < prev.length; i++) {
			if (prev[i]!.ctor === ctor) {
				alreadyDeclared = true
				break
			}
		}
		if (!alreadyDeclared) {
			const next = prev.length === 0 ? [{ ctor, exportKey }] : [...prev, { ctor, exportKey }]
			this.moduleMap.set(moduleId, next)
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
		return name
	}

	/** 清空模块的声明（通常在 replace/prune 前调用） */
	undeclareModule(moduleId: ModuleId, tx?: ReturnType<PluginRegistry['beginTransaction']>): void {
		tx?.recordModule(moduleId)
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const item of list) {
			const ctor = item.ctor
			const { id: name } = getPluginInfo(ctor)
			tx?.recordName(name)

			// 仅当映射仍指向该 moduleId 才移除（避免其他路径已重建时误删）
			if (this.name2Path.get(name) === moduleId) {
				this.nameMap.delete(name)
				this.name2Path.delete(name)
				this.name2ExportKey.delete(name)
			}
			const prevSeen = this.enrolled.get(ctor)
			if (!prevSeen) continue
			if (tx) {
				tx.recordEnrolled(ctor)
				const next = new Set(prevSeen)
				next.delete(moduleId)
				if (next.size === 0) this.enrolled.delete(ctor)
				else this.enrolled.set(ctor, next)
				continue
			}
			prevSeen.delete(moduleId)
			if (prevSeen.size === 0) this.enrolled.delete(ctor)
		}
		this.moduleMap.delete(moduleId)
	}

	// =============== 运行层：启/停 ===============
	/** 根据 config 启用位，为该模块内需要启用的插件执行 start */
	async syncRuntimeForModule(
		moduleId: ModuleId,
		options: { refreshRegistered?: boolean; restartRegistered?: boolean } = {},
	): Promise<void> {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		const starts: Array<Promise<void>> = []
		const safeStart = (name: string, ctor: PluginConstructor) =>
			this.startPlugin(name, ctor, options).catch((error) => {
				this.ctx.logger.warn('启动失败：{name}', { name, moduleId, error })
			})

		// 并行启动（registerPlugin 只是声明，依赖处理在 commit 时）
		for (const { ctor } of list) {
			const { id: name } = getPluginInfo(ctor)
			if (!this.isPrimaryProvider(moduleId, ctor)) continue
			if (!this.ctx.configService.isEnabledInConfig(name)) continue
			starts.push(safeStart(name, ctor))
		}

		// Forks: start enabled forks for forkable plugins from this module.
		for (const { ctor } of list) {
			let name: string
			try {
				name = getPluginInfo(ctor).id
			} catch {
				continue
			}
			const forkIds = this.getForkIds(name)
			if (forkIds.length === 0) continue

			for (const forkId of forkIds) {
				let forkName: string
				try {
					forkName = formatForkPluginId(name, forkId)
				} catch {
					continue
				}
				if (!this.ctx.configService.isEnabledInConfig(forkName)) continue
				try {
					const ForkCtor = this.ctx.registry.fork(
						ctor as unknown as ForkablePluginConstructor,
						forkId,
					) as PluginConstructor
					starts.push(safeStart(forkName, ForkCtor))
				} catch (err) {
					this.ctx.logger.warn('启动 fork 失败：{name}#{forkId}', {
						name,
						forkId,
						error: err,
					})
				}
			}
		}
		if (starts.length > 0) await Promise.all(starts)
	}

	async enable(
		name: PluginName,
		ctor: PluginConstructor,
		options: { refreshRegistered?: boolean; restartRegistered?: boolean } = {},
	): Promise<void> {
		await this.startPlugin(name, ctor, options)
	}

	async startPlugin(
		name: PluginName,
		ctor: PluginConstructor,
		options: { refreshRegistered?: boolean; restartRegistered?: boolean } = {},
	): Promise<void> {
		const provideBase = this.resolveProvideBase(name, ctor)
		const schema = this.getSchema(ctor)
		if (schema) {
			await this.ctx.configService.ensureValidated(name, schema, {
				missingObjectDefault: {},
			})
		}

		// 进入运行层（两段式，失败回滚）
		let enabled = false
		try {
			if (!this.ctx.configService.isEnabledInConfig(name)) {
				this.ctx.configService.enableInConfig(name)
			}
			enabled = true
			// Idempotency: enable/start may be invoked multiple times (config ready races, user clicks, etc.).
			// Avoid treating "already registered" as a failure, as the rollback would incorrectly unregister
			// an otherwise healthy plugin registration and desync UI/runtime.
			const wasRegistered = this.ctx.registry.isRegistered(ctor)
			if (options.refreshRegistered || !wasRegistered) {
				this.ctx.registry.register(ctor, provideBase === undefined ? undefined : { provideBase })
			}
			if (options.restartRegistered && wasRegistered) {
				this.ctx.registry.restart(ctor, { cascadeDependents: false })
			}
			if (provideBase) {
				try {
					const info = getPluginInfo(ctor)
					const base = info.base as unknown as PluginIdentifier | null
					if (base) this.recordBaseProvider(base, name)
				} catch {
					// ignore: best-effort attribution
				}
			}
		} catch (err) {
			// 回滚
			this.logGuard(`core.unregister(${name})`, () => {
				this.ctx.registry.unregister(ctor)
			})
			if (enabled) {
				this.logGuard(`config.disable(${name})`, () => {
					this.ctx.configService.disableInConfig(name)
				})
			}
			throw err
		}
	}

	/** 只停运行层（保留 config 启用位） */
	stopPlugin(
		name: PluginName,
		ctor: PluginConstructor,
		options: { cascadeDependents?: boolean } = {},
	): void {
		this.logGuard(`core.unregister(${name})`, () => {
			this.ctx.registry.unregister(ctor, {
				cascadeDependents: options.cascadeDependents ?? true,
			})
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
	stopModule(moduleId: ModuleId, options: { cascadeDependents?: boolean } = {}): void {
		const list = this.moduleMap.get(moduleId) ?? EMPTY
		for (const { ctor } of list) {
			const { id: name } = getPluginInfo(ctor)
			if (!this.isPrimaryProvider(moduleId, ctor)) continue
			this.stopPlugin(name, ctor, options)

			// Stop forks derived from this ctor as well (module is going away).
			for (const forkCtor of this.ctx.registry.listForks(ctor)) {
				try {
					const forkName = getPluginInfo(forkCtor).id
					this.stopPlugin(forkName, forkCtor, options)
				} catch {
					// ignore: best-effort cleanup
				}
			}
		}
	}

	// =============== 持久层（配置启用位） ===============
	enablePersisted(...names: readonly string[]): void {
		this.ctx.configService.batch(() => this.ctx.configService.enableInConfig(...names))
	}
	disablePersisted(...names: readonly string[]): void {
		this.ctx.configService.batch(() => this.ctx.configService.disableInConfig(...names))
	}
	/** 将该模块内所有插件的持久启用位关闭（用于 prune(persisted)） */
	disablePersistedByModule(moduleId: ModuleId): void {
		this.ctx.configService.batch(() => {
			const list = this.moduleMap.get(moduleId) ?? EMPTY
			for (const { ctor } of list) {
				const { id: name } = getPluginInfo(ctor)
				if (!this.isPrimaryProvider(moduleId, ctor)) continue
				this.ctx.configService.disableInConfig(name)

				const forkIds = this.getForkIds(name)
				for (const forkId of forkIds) {
					try {
						this.ctx.configService.disableInConfig(formatForkPluginId(name, forkId))
					} catch {
						// ignore invalid persisted fork ids
					}
				}
			}
		})
	}

	// --------------- 工具 ---------------
	private resolveProvideBase(name: PluginName, ctor: PluginConstructor): boolean | undefined {
		// Base provider selection (global default):
		// - keep multiple providers enabled/running if desired;
		// - only the selected provider binds the base token alias (provideBase=true);
		// - others register only by their ctor (provideBase=false).
		let provideBase: boolean | undefined
		try {
			const info = getPluginInfo(ctor)
			const base = info.base as unknown as PluginIdentifier | null
			if (!base) return undefined

			// Forks must never implicitly replace or claim base-provider aliases.
			// They may run in parallel with the primary provider without touching base DI routing.
			if (getForkOf(ctor)) return false

			const baseKey = getDeclaredName(base)
			const map = this.ctx.configService.getExtra<BaseProvidersExtra>(EXTRA_BASE_PROVIDERS) ?? {}
			const selectedRaw = map?.[baseKey]
			const selected =
				typeof selectedRaw === 'string' && selectedRaw.trim().length > 0 ? selectedRaw.trim() : null
			const selectedIsForkName = selected ? isForkPluginId(selected) : false
			const selectedCtor = selected && !selectedIsForkName ? this.nameMap.get(selected) : undefined
			const selectedIsForkCtor = selectedCtor ? Boolean(getForkOf(selectedCtor)) : false
			const selectedEnabled =
				selectedCtor && selected && !selectedIsForkName
					? this.ctx.configService.isEnabledInConfig(selected)
					: false

			const selectedValid = Boolean(
				selected && !selectedIsForkName && selectedCtor && !selectedIsForkCtor && selectedEnabled,
			)

			const pickFallback = (): string | null => {
				const candidates: string[] = []
				for (const [candidateName, candidateCtor] of this.nameMap) {
					// nameMap is declaration-only; still be defensive.
					if (isForkPluginId(candidateName)) continue
					if (candidateName !== name && !this.ctx.configService.isEnabledInConfig(candidateName))
						continue

					try {
						if (getForkOf(candidateCtor)) continue
						const cInfo = getPluginInfo(candidateCtor)
						const cBase = cInfo.base as unknown as PluginIdentifier | null
						if (!cBase) continue
						if (getDeclaredName(cBase) !== baseKey) continue
						candidates.push(candidateName)
					} catch {
						// ignore: best-effort fallback selection
					}
				}
				candidates.sort((a, b) => a.localeCompare(b))
				return candidates[0] ?? null
			}

			if (selectedValid) {
				provideBase = selected === name
			} else {
				// Invalid selection (unknown provider / fork id / empty / disabled).
				// Fall back deterministically to keep DI resolvable and avoid alias conflicts.
				const fallback = pickFallback() ?? name
				provideBase = fallback === name

				// Persist the fallback so future commits stay deterministic.
				if (map[baseKey] !== fallback) {
					this.ctx.configService.setExtra(EXTRA_BASE_PROVIDERS, { ...map, [baseKey]: fallback })
				}
			}
		} catch {
			// ignore
		}
		return provideBase
	}

	private logGuard(label: string, fn: () => void) {
		try {
			fn()
		} catch (err) {
			this.ctx.logger.warn('可恢复异常：{label}', { label, error: err })
		}
	}
}
