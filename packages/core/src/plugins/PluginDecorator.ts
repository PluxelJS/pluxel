// PluginDecorator.ts
// Definition‑time decorators and metadata store for plugins.
// All data here is immutable after decoration, and optimized for fast reads
// during DI construction.
import 'reflect-metadata'
import { BasePlugin } from './BasePlugin'
import type { Identifier, PluginIdentifier, SubclassOf } from './types'

/*───────────────────────────────────────────────────────────
  Runtime Policy
  - DEV: 冻结返回值/快照，尽早暴露"误改"。
  - PROD: 不冻结，避免隐藏类固定/写屏障。
  - 热路径 = 1× WeakMap.get → 固定 shape 的 State 属性访问。
───────────────────────────────────────────────────────────*/
const __DEV__ =
	(globalThis as any).__PLUXEL_DEV__ ??
	(typeof process !== 'undefined' ? process.env?.NODE_ENV === 'dev' : true)
const $freeze = <T>(x: T): T => (__DEV__ ? Object.freeze(x) : x)
const EMPTY_ARR: readonly unknown[] = $freeze([])

/*───────────────────────────────────────────────────────────
  Public Types / Stable API
───────────────────────────────────────────────────────────*/
export interface PluginMetadata {
	/** 声明期 name，可缺省；最终 id 由 Loader 决定 */
	name?: string
	[key: string]: any
}

/** "对外快照"里 meta 字段改名为 metadata，避免与 id/name 冲突 */
export type DeclaredMetaView = Omit<PluginMetadata, 'name'>

export type ConfigSchemaList<T = any> = Record<string, T>

/** TS emitDecoratorMetadata 的 key（构造参数类型） */
export const PARAM_TYPES = 'design:paramtypes' as const

/** 稀疏覆盖（数组/对象） */
export type ParamOverride =
	| ReadonlyArray<Identifier<any> | undefined>
	| Readonly<Partial<Record<number, Identifier<any>>>>

/**
 * 对外快照：PluginInfo
 *
 * 命名语义：
 * - id: 系统唯一标识符，用于 DI 容器注册、配置查找、日志标识
 * - displayName: UI 展示用的人类可读名（可国际化）
 * - declaredName: @Plugin({ name }) 的原始值（不可变）
 * - packageName: 来源包名，用于冲突检测和前缀生成
 */
export interface PluginInfo {
	/** 系统唯一标识符（loader 可设置，默认等于 declaredName） */
	readonly id: string
	/** 显示名（UI/日志用，默认等于 id） */
	readonly displayName: string
	/** 声明期原始名（@Plugin({ name }) 或 ctor.name，不可变） */
	readonly declaredName: string
	/** 来源包名（由 loader 注入） */
	readonly packageName: string | null
	/** 插件类构造函数引用 */
	readonly class: PluginIdentifier
	/** 声明的抽象基类 */
	readonly base: PluginIdentifier | null
	/** 声明期元信息（去掉 name 后的剩余字段） */
	readonly metadata: DeclaredMetaView | null
	/** 由 @Config 聚合出的 schema map（null-proto 对象） */
	readonly configMap: ConfigSchemaList | null
	/** 由 Vite 插件注入的 @Config 源代码 map（fieldName -> source） */
	readonly configSourceMap: Readonly<Record<string, string>> | null
}

/** @deprecated 使用 PluginInfo.id 代替 */
export type { PluginInfo as PluginInfoLegacy }

/*───────────────────────────────────────────────────────────
  Internal State（单 WM，固定 shape，JIT 友好）
  所有字段使用 null 而非 undefined（V8 优化）
───────────────────────────────────────────────────────────*/
type Tokens = Array<Identifier<any> | undefined>

interface State {
	// ═══════════════════════════════════════════════════════
	// 冷数据（@Plugin 时一次性写入，热路径只读）
	// ═══════════════════════════════════════════════════════
	/** 声明期元数据（去掉 name 后） */
	declaredMeta: DeclaredMetaView | null
	/** 声明期原始名（不可变） */
	declaredName: string | null
	/** 抽象基类 */
	base: PluginIdentifier | null
	/** @Config 聚合结果 */
	config: ConfigSchemaList | null
	/** Vite 插件注入的 @Config 源代码 */
	configSource: Record<string, string> | null
	/** 预取的设计期构造参数类型（热路径不再触碰 Reflect） */
	rtypes: readonly unknown[]
	/** 插件类引用 */
	ctor: PluginIdentifier | null

	// ═══════════════════════════════════════════════════════
	// 可变身份数据（外部可 set，重建 snapshot 但不动 epoch）
	// ═══════════════════════════════════════════════════════
	/** 系统唯一标识符（loader 设置） */
	id: string | null
	/** 显示名（UI 用） */
	displayName: string | null
	/** 来源包名（loader 注入） */
	packageName: string | null

	// ═══════════════════════════════════════════════════════
	// 热数据：参数 tokens + 缓存
	// ═══════════════════════════════════════════════════════
	tokens: Tokens | null
	epoch: number
	paramCacheEpoch: number
	paramCache: readonly unknown[] | null

	// ═══════════════════════════════════════════════════════
	// 对外信息快照
	// ═══════════════════════════════════════════════════════
	infoSnap: PluginInfo | null

	// ═══════════════════════════════════════════════════════
	// 定义期暂存（@Plugin 聚合后清空）
	// ═══════════════════════════════════════════════════════
	pending: Record<string, unknown> | null
}

const STATE = new WeakMap<Function, State>()

/** 获取或创建 State（固定 shape，JIT 友好） */
const S = (ctor: Function): State => {
	let s = STATE.get(ctor)
	if (s) return s
	// 所有字段显式初始化为 null，保持固定 shape
	s = {
		declaredMeta: null,
		declaredName: null,
		base: null,
		config: null,
		configSource: null,
		rtypes: EMPTY_ARR,
		ctor: null,

		id: null,
		displayName: null,
		packageName: null,

		tokens: null,
		epoch: 0,
		paramCacheEpoch: -1,
		paramCache: null,

		infoSnap: null,
		pending: null,
	}
	STATE.set(ctor, s)
	return s
}

/*───────────────────────────────────────────────────────────
  Tiny Utils
───────────────────────────────────────────────────────────*/
const nameOf = (fn: any): string => (fn && fn.name) || '<anonymous>'

const isSubclassOf = (ctor: Function, base: Function): boolean => {
	if (ctor === base) return true
	if (typeof ctor !== 'function' || typeof base !== 'function') return false
	const cp = (ctor as any).prototype
	const bp = (base as any).prototype
	return !!(cp && bp && bp.isPrototypeOf(cp))
}

/** tokens 变更 → 仅失效构造参数缓存（与身份数据无关） */
const bumpTokens = (s: State): void => {
	s.epoch++
	s.paramCache = null
	s.paramCacheEpoch = -1
}

function sparseObjectToArray(o: Readonly<Record<number, Identifier<any>>>): Tokens {
	const ks = Object.keys(o)
	if (!ks.length) return []
	let max = -1
	for (let i = 0; i < ks.length; i++) {
		const idx = (ks[i] as unknown as number) | 0
		if (idx > max) max = idx
	}
	const arr = new Array<Identifier<any> | undefined>(max + 1)
	for (let i = 0; i < ks.length; i++) {
		const idx = (ks[i] as unknown as number) | 0
		arr[idx] = (o as any)[idx]
	}
	return arr
}

function applyOverride(dst: unknown[], override?: ParamOverride): void {
	if (!override) return
	if (Array.isArray(override)) {
		for (let i = 0; i < override.length; i++) {
			const v = override[i]
			if (v !== undefined) dst[i] = v
		}
	} else {
		const ks = Object.keys(override)
		for (let i = 0; i < ks.length; i++) {
			const idx = (ks[i] as unknown as number) | 0
			const v = (override as any)[idx]
			if (v !== undefined) dst[idx] = v
		}
	}
}

/*───────────────────────────────────────────────────────────
  Snapshot Builder
───────────────────────────────────────────────────────────*/

/** 重建对外快照（不动 epoch） */
function rebuildInfoSnapshot(ctor: Function, s: State): void {
	const declaredName = s.declaredName || nameOf(ctor)
	const id = s.id || declaredName
	const displayName = s.displayName || id

	const configSourceMap =
		s.configSource && Object.keys(s.configSource).length
			? normalizeConfigSourceMap(s.configSource)
			: null

	const snap: PluginInfo = {
		id,
		displayName,
		declaredName,
		packageName: s.packageName,
		class: (s.ctor || ctor) as PluginIdentifier,
		base: s.base,
		metadata: s.declaredMeta,
		configMap: s.config,
		configSourceMap,
	}

	s.infoSnap = __DEV__ ? $freeze(snap) : snap
}

/*───────────────────────────────────────────────────────────
  Decorators
───────────────────────────────────────────────────────────*/

/** 收集实例字段配置（@Plugin 统一聚合） */
export function Config<S extends ConfigSchemaList>(schema: S): PropertyDecorator {
	return (target: object, key: string | symbol) => {
		if (typeof target === 'function') throw new Error('@Config 只能用于实例字段(非 static)')
		const ctor = (target as any).constructor as Function
		const s = S(ctor)
		const bucket = s.pending ?? Object.create(null)
		bucket[String(key)] = schema
		s.pending = bucket
	}
}

/**
 * 声明插件（可选基类）：
 * - 校验继承关系
 * - 预取 design:paramtypes → rtypes（热路径不再触碰 Reflect）
 * - 聚合 pending @Config → config
 * - 构建对外快照
 */
export function Plugin(meta?: PluginMetadata): ClassDecorator
export function Plugin<B extends PluginIdentifier>(
	base: B,
	meta?: PluginMetadata,
): <C extends SubclassOf<B>>(ctor: C) => void
export function Plugin(a?: PluginMetadata | PluginIdentifier, b?: PluginMetadata) {
	const withBase = typeof a === 'function'
	const base = (withBase ? (a as PluginIdentifier) : null) as PluginIdentifier | null
	const meta = (
		withBase ? ((b as PluginMetadata) ?? {}) : ((a as PluginMetadata) ?? {})
	) as PluginMetadata

	return (ctor: Function) => {
		if (base) {
			if (!isSubclassOf(base as Function, BasePlugin)) {
				throw new Error(`@Plugin(${nameOf(base)}) 失败：抽象基类未继承 BasePlugin`)
			}
			if (!isSubclassOf(ctor, base as Function)) {
				throw new Error(`@Plugin(${nameOf(base)}) 失败：${nameOf(ctor)} 未继承 ${nameOf(base)}`)
			}
		}

		const s = S(ctor)

		// 预取设计期类型
		const rt = (Reflect.getMetadata(PARAM_TYPES, ctor) as unknown[]) ?? EMPTY_ARR
		s.rtypes = Array.isArray(rt) ? rt : Array.from(rt)

		// 存储 ctor 引用
		s.ctor = ctor as PluginIdentifier

		// 提取并存储 declaredName
		const { name: declaredName, ...restMeta } = meta
		s.declaredName = declaredName || nameOf(ctor)
		s.declaredMeta =
			Object.keys(restMeta).length > 0
				? (__DEV__ ? $freeze(restMeta as DeclaredMetaView) : (restMeta as DeclaredMetaView))
				: null

		s.base = base

		// 聚合 pending @Config
		if (s.pending && Object.keys(s.pending).length) {
			s.config = __DEV__ ? $freeze(s.pending as ConfigSchemaList) : (s.pending as ConfigSchemaList)
			s.pending = null
		} else {
			s.config = null
		}

		// 构建对外快照
		rebuildInfoSnapshot(ctor, s)
	}
}

/*───────────────────────────────────────────────────────────
  Identity APIs：外部可设置身份信息
───────────────────────────────────────────────────────────*/

/** 获取声明期原始名（不可变） */
export function getDeclaredName(ctor: Function): string {
	const s = STATE.get(ctor)
	return s?.declaredName || nameOf(ctor)
}

/** 获取系统 ID（考虑 loader 设置） */
export function getPluginId(ctor: Function): string {
	const s = STATE.get(ctor)
	return s?.id || s?.declaredName || nameOf(ctor)
}

/** 获取显示名 */
export function getDisplayName(ctor: Function): string {
	const s = STATE.get(ctor)
	return s?.displayName || s?.id || s?.declaredName || nameOf(ctor)
}

/** 获取包名 */
export function getPackageName(ctor: Function): string | null {
	return STATE.get(ctor)?.packageName ?? null
}

/** 设置系统 ID（通常由 loader 调用） */
export function setPluginId(ctor: Function, id: string | null): void {
	const s = S(ctor)
	s.id = id
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** 设置显示名 */
export function setDisplayName(ctor: Function, name: string | null): void {
	const s = S(ctor)
	s.displayName = name
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** 设置包名（通常由 loader 调用） */
export function setPackageName(ctor: Function, name: string | null): void {
	const s = S(ctor)
	s.packageName = name
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/**
 * 批量设置身份信息（减少多次 rebuild）
 */
export function setPluginIdentity(
	ctor: Function,
	identity: { id?: string | null; displayName?: string | null; packageName?: string | null },
): void {
	const s = S(ctor)
	if (identity.id !== undefined) s.id = identity.id
	if (identity.displayName !== undefined) s.displayName = identity.displayName
	if (identity.packageName !== undefined) s.packageName = identity.packageName
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** @deprecated 使用 setPluginId 代替 */
export function setPluginName(ctor: Function, name?: string | null): void {
	setPluginId(ctor, name ?? null)
}

/** @deprecated 使用 getPluginId 代替 */
export function getEffectiveName(ctor: Function): string {
	return getPluginId(ctor)
}

/*───────────────────────────────────────────────────────────
  Read APIs
───────────────────────────────────────────────────────────*/

export function checkPluginDecorator(ctor: Function): boolean {
	const s = STATE.get(ctor)
	return !!(s?.infoSnap)
}

export function getPluginInfo(ctor: Function): PluginInfo {
	const s = STATE.get(ctor)
	if (!s || !s.infoSnap) {
		throw new Error(`getPluginInfo(${nameOf(ctor)}) 在未装饰的类上被调用，请先使用 @Plugin`)
	}
	return s.infoSnap
}

export function getBaseClass(target: Function): PluginIdentifier | null {
	return STATE.get(target)?.base ?? null
}

export function resolvePluginRoot(id: PluginIdentifier): PluginIdentifier {
	if (typeof id !== 'function') return id
	let cur: Function = id
	const seen = new Set<Function>()
	while (typeof cur === 'function') {
		if (seen.has(cur)) break
		seen.add(cur)
		const base = STATE.get(cur)?.base
		if (!base || base === cur) break
		cur = base as Function
	}
	return cur as PluginIdentifier
}

export function isPluginOf<B extends PluginIdentifier>(
	ctor: Function,
	base: B,
	deep = false,
): boolean {
	const tagged = getBaseClass(ctor)
	if (!tagged) return false
	return deep ? isSubclassOf(tagged as Function, base as Function) : tagged === base
}

export function filterPluginsOf<B extends PluginIdentifier>(
	list: Function[],
	base: B,
	deep = false,
) {
	return list.filter((c) => isPluginOf(c, base, deep)) as SubclassOf<B>[]
}

/*───────────────────────────────────────────────────────────
  Hot Path：构造参数解析
  数据源：rtypes（预取） → tokens（持久） → override（一次性）
  命中缓存：0 分配；失配：1× slice + 0~2× 稀疏覆盖。
───────────────────────────────────────────────────────────*/

export function getClassParams<T = unknown>(
	target: Function,
	override?: ParamOverride,
): readonly T[] {
	const s = S(target)

	if (!override && s.paramCache && s.paramCacheEpoch === s.epoch) {
		return s.paramCache as readonly T[]
	}

	// 1) 预取 rtypes 作为基数组
	const out = s.rtypes.length ? (s.rtypes as unknown[]).slice() : []

	// 2) 应用持久 tokens（数组形态，最快）
	if (s.tokens) applyOverride(out, s.tokens)

	// 3) 应用一次性 override
	applyOverride(out, override)

	const ro = __DEV__ ? $freeze(out) : (out as readonly unknown[])
	if (!override) {
		s.paramCache = ro
		s.paramCacheEpoch = s.epoch
	}
	return ro as readonly T[]
}

/*───────────────────────────────────────────────────────────
  Tokens：持久覆盖（写入即失效；不影响身份数据）
───────────────────────────────────────────────────────────*/

export function setParamToken(ctor: Function, index: number, token: Identifier<any>): void {
	const s = S(ctor)
	const next = s.tokens ? s.tokens.slice() : []
	if (index >= next.length) next.length = index + 1
	next[index] = token
	s.tokens = next
	bumpTokens(s)
}

export function setParamTokens(ctor: Function, override: ParamOverride): void {
	const s = S(ctor)
	const base = s.tokens ? s.tokens.slice() : []
	if (Array.isArray(override)) applyOverride(base, override)
	else applyOverride(base, sparseObjectToArray(override as any))
	s.tokens = base
	bumpTokens(s)
}

export function clearParamToken(ctor: Function, index: number): void {
	const s = S(ctor)
	if (!s.tokens) return
	const next = s.tokens.slice()
	if (index < next.length) {
		next[index] = undefined
		// 紧凑收尾
		let end = next.length
		while (end > 0 && next[end - 1] === undefined) end--
		next.length = end
	}
	s.tokens = next
	bumpTokens(s)
}

export function clearParamTokens(ctor: Function): void {
	const s = S(ctor)
	if (!s.tokens) return
	s.tokens = null
	bumpTokens(s)
}

/** 只读观察当前 tokens 视图（拷贝；DEV 下冻结） */
export function getStoredParamTokens(
	ctor: Function,
): ReadonlyArray<Identifier<any> | undefined> | undefined {
	const t = STATE.get(ctor)?.tokens
	if (!t) return undefined
	const copy = t.slice()
	return __DEV__ ? $freeze(copy) : copy
}

/*───────────────────────────────────────────────────────────
  Config Source：Vite 插件注入的 @Config 源代码
───────────────────────────────────────────────────────────*/

/**
 * 由 Vite 插件在编译期注入，存储 @Config 装饰器参数的源代码。
 */
export function __setConfigSource__(ctor: Function, fieldName: string, source: string): void {
	const s = S(ctor)
	const bucket = s.configSource ?? Object.create(null)
	bucket[fieldName] = source
	s.configSource = bucket
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** 读取 @Config 源代码 map */
export function getConfigSource(ctor: Function): Readonly<Record<string, string>> | null {
	const s = STATE.get(ctor)
	return normalizeConfigSourceMap(s?.configSource ?? null)
}

function normalizeConfigSourceMap(
	source: Record<string, string> | null,
): Readonly<Record<string, string>> | null {
	if (!source || !Object.keys(source).length) return null
	const proto = Object.getPrototypeOf(source)
	if (!__DEV__ && proto === Object.prototype) {
		return source as Readonly<Record<string, string>>
	}
	const plain = { ...source }
	return __DEV__ ? $freeze(plain) : plain
}
