// PluginDecorator.ts
import 'reflect-metadata'
import { BasePlugin } from './BasePlugin'
import type { Identifier, PluginIdentifier, SubclassOf } from './types'

/*───────────────────────────────────────────────────────────
  Runtime Policy
  - DEV: 冻结返回值/快照，尽早暴露“误改”。
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
	/** 声明期 name，可缺省；最终对外名由 Loader/外部 rename 决定 */
	name?: string
	[key: string]: any
}
/** “对外快照”里 meta 字段改名为 metadata，避免与对外 name 冲突 */
export type DeclaredMetaView = Omit<PluginMetadata, 'name'>

export type ConfigSchemaList<T = any> = Record<string, T>
/** TS emitDecoratorMetadata 的 key（构造参数类型） */
export const PARAM_TYPES = 'design:paramtypes' as const

/** 稀疏覆盖（数组/对象） */
export type ParamOverride =
	| ReadonlyArray<Identifier<any> | undefined>
	| Readonly<Partial<Record<number, Identifier<any>>>>

/** 对外快照：你要的 .name 在顶层 */
export interface PluginInfo {
	/** 对外名：State.name（别名） ?? declared name ?? ctor.name */
	readonly name: string
	/** 声明期元信息（去掉 name 后的剩余字段） */
	readonly metadata?: DeclaredMetaView
	/** 声明的抽象基类 */
	readonly base?: PluginIdentifier
	/** 由 @Config 聚合出的 schema map（null-proto 对象） */
	readonly configMap?: ConfigSchemaList
	/** 由 Vite 插件注入的 @Config 源代码 map（fieldName -> source） */
	readonly configSourceMap?: Readonly<Record<string, string>>
}

/*───────────────────────────────────────────────────────────
  Internal State（单 WM，固定 shape，JIT 友好）
───────────────────────────────────────────────────────────*/
type Tokens = Array<Identifier<any> | undefined>
type State = {
	// 声明期冷数据（@Plugin 时一次性写入）
	declaredMeta: PluginMetadata | null
	base: PluginIdentifier | null
	config: ConfigSchemaList | null
	// Vite 插件注入的 @Config 源代码（fieldName -> source）
	configSource: Record<string, string> | null

	// 预取的设计期构造参数类型（热路径不再触碰 Reflect）
	rtypes: readonly unknown[]

	// 对外名（别名）；外部可 set，不改 epoch
	name: string | null

	// 热数据：参数 tokens + 缓存
	tokens: Tokens | null
	epoch: number
	paramCacheEpoch: number
	paramCache: readonly unknown[] | null

	// 对外信息快照（含顶层 .name）
	infoSnap: PluginInfo | null

	// 定义期 @Config 暂存桶（null-proto），@Plugin 聚合落盘
	pending: Record<string, unknown> | null
}

const STATE = new WeakMap<Function, State>()
const S = (ctor: Function): State => {
	let s = STATE.get(ctor)
	if (s) return s
	s = {
		declaredMeta: null,
		base: null,
		config: null,
		configSource: null,
		rtypes: EMPTY_ARR,
		name: null,

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
const nameOf = (fn: any) => (fn && fn.name) || '<anonymous>'
const fallbackCtorName = (ctor: Function) => nameOf(ctor)
const isSubclassOf = (ctor: Function, base: Function) => {
	if (ctor === base) return true
	if (typeof ctor !== 'function' || typeof base !== 'function') return false
	const cp = (ctor as any).prototype
	const bp = (base as any).prototype
	return !!(cp && bp && bp.isPrototypeOf(cp))
}
/** tokens 变更 → 仅失效构造参数缓存（与对外名无关） */
const bump = (ctor: Function) => {
	const s = S(ctor)
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

/** 依据"当前有效对外名"重建对外快照（不动 epoch） */
function rebuildInfoSnapshot(ctor: Function, s: State): void {
	const declaredName = s.declaredMeta?.name ?? fallbackCtorName(ctor)
	const effectiveName = s.name ?? declaredName

	// 去掉声明期 name 后的元信息（让 .name 只存在顶层）
	const { name: _omit, ...restMeta } = (s.declaredMeta ?? {}) as PluginMetadata
	const metadata: DeclaredMetaView | undefined = Object.keys(restMeta).length
		? (restMeta as DeclaredMetaView)
		: undefined

	const configSourceMap =
		s.configSource && Object.keys(s.configSource).length
			? (normalizeConfigSourceMap(s.configSource) as Readonly<Record<string, string>>)
			: undefined

	const snap: PluginInfo = __DEV__
		? $freeze({
				name: effectiveName,
				metadata,
				base: (s.base ?? undefined) as PluginIdentifier | undefined,
				configMap: s.config ?? undefined,
				configSourceMap,
			})
		: {
				name: effectiveName,
				metadata,
				base: (s.base ?? undefined) as PluginIdentifier | undefined,
				configMap: s.config ?? undefined,
				configSourceMap,
			}

	s.infoSnap = snap
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
		const bucket = s.pending ?? Object.create(null) // null-proto：干净字典
		bucket[String(key)] = schema
		s.pending = bucket
	}
}

/**
 * 声明插件（可选基类）：
 * - 校验继承关系
 * - 预取 design:paramtypes → rtypes（热路径不再触碰 Reflect）
 * - 聚合 pending @Config → config
 * - 构建对外快照（含顶层 .name）
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

		// 冷数据写入（DEV 下浅拷贝 + 冻结，抓误改）
		s.declaredMeta = __DEV__ ? $freeze({ ...meta }) : { ...meta }
		s.base = base

		// 聚合 pending @Config
		if (s.pending && Object.keys(s.pending).length) {
			s.config = __DEV__ ? $freeze(s.pending) : s.pending
			s.pending = null
		} else {
			s.config = null
		}

		// 构建对外快照
		rebuildInfoSnapshot(ctor, s)
	}
}

/*───────────────────────────────────────────────────────────
  Name：外部可重命名（不动 epoch）
───────────────────────────────────────────────────────────*/
/** 读取声明名（未考虑外部 rename）：meta.name ?? ctor.name */
export function getDeclaredName(ctor: Function): string {
	const s = STATE.get(ctor)
	if (!s) return fallbackCtorName(ctor)
	return s.declaredMeta?.name ?? fallbackCtorName(ctor)
}

/** 读取对外名（已考虑 rename）：state.name ?? declaredName */
export function getEffectiveName(ctor: Function): string {
	const s = STATE.get(ctor)
	if (!s) return fallbackCtorName(ctor)
	return s.name ?? s.declaredMeta?.name ?? fallbackCtorName(ctor)
}

/** 设置/清除对外名（只重建 infoSnap，热路径缓存不失效） */
export function setPluginName(ctor: Function, name?: string | null): void {
	const s = S(ctor)
	s.name = name ?? null
	rebuildInfoSnapshot(ctor, s)
}

/*───────────────────────────────────────────────────────────
  Read APIs（外界承诺先检查 @Plugin 装饰器）
───────────────────────────────────────────────────────────*/
export function checkPluginDecorator(ctor: Function): boolean {
	const s = STATE.get(ctor)
	if (s?.infoSnap) return true
	return false
}
export function getPluginInfo(ctor: Function): PluginInfo {
	const s = STATE.get(ctor)
	if (!s || !s.infoSnap) {
		throw new Error(`getPluginInfo(${nameOf(ctor)}) 在未装饰的类上被调用，请先使用 @Plugin`)
	}
	return s.infoSnap
}

export function getBaseClass(target: Function): PluginIdentifier | undefined {
	return (STATE.get(target)?.base ?? undefined) as PluginIdentifier | undefined
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
  Tokens：持久覆盖（写入即失效；不影响对外名）
───────────────────────────────────────────────────────────*/
export function setParamToken(ctor: Function, index: number, token: Identifier<any>): void {
	const s = S(ctor)
	const next = s.tokens ? s.tokens.slice() : []
	if (index >= next.length) next.length = index + 1
	next[index] = token
	s.tokens = next
	bump(ctor)
}

export function setParamTokens(ctor: Function, override: ParamOverride): void {
	const s = S(ctor)
	const base = s.tokens ? s.tokens.slice() : []
	if (Array.isArray(override)) applyOverride(base, override)
	else applyOverride(base, sparseObjectToArray(override as any))
	s.tokens = base
	bump(ctor)
}

export function clearParamToken(ctor: Function, index: number): void {
	const s = S(ctor)
	if (!s.tokens) return
	const next = s.tokens.slice()
	if (index < next.length) {
		next[index] = undefined
		// 紧凑收尾，避免“越用越长”
		let end = next.length
		while (end > 0 && next[end - 1] === undefined) end--
		next.length = end
	}
	s.tokens = next
	bump(ctor)
}

export function clearParamTokens(ctor: Function): void {
	const s = S(ctor)
	if (!s.tokens) return
	s.tokens = null
	bump(ctor)
}

/** 只读观察当前 tokens 视图（拷贝；DEV 下冻结） */
export function getStoredParamTokens(
	ctor: Function,
): ReadonlyArray<Identifier<any> | undefined> | undefined {
	const t = STATE.get(ctor)?.tokens
	if (!t) return
	const copy = t.slice()
	return __DEV__ ? $freeze(copy) : copy
}

/*───────────────────────────────────────────────────────────
  Config Source：Vite 插件注入的 @Config 源代码
  - __setConfigSource__：编译期注入（由 Vite 插件调用）
  - getConfigSource：读取源代码 map
───────────────────────────────────────────────────────────*/

/**
 * 由 Vite 插件在编译期注入，存储 @Config 装饰器参数的源代码。
 * 在 @Plugin 装饰器执行后调用，因为此时 ctor 已经完成类定义。
 */
export function __setConfigSource__(
	ctor: Function,
	fieldName: string,
	source: string,
): void {
	const s = S(ctor)
	const bucket = s.configSource ?? Object.create(null)
	bucket[fieldName] = source
	s.configSource = bucket
	// 重建快照以包含新的 configSourceMap
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** 读取 @Config 源代码 map（fieldName -> source） */
export function getConfigSource(
	ctor: Function,
): Readonly<Record<string, string>> | undefined {
	const s = STATE.get(ctor)
	return normalizeConfigSourceMap(s?.configSource ?? undefined)
}

function normalizeConfigSourceMap(
	source: Record<string, string> | null | undefined,
): Readonly<Record<string, string>> | undefined {
	if (!source || !Object.keys(source).length) return undefined
	const proto = Object.getPrototypeOf(source)
	if (!__DEV__ && proto === Object.prototype) {
		return source as Readonly<Record<string, string>>
	}
	const plain = { ...source }
	return __DEV__ ? $freeze(plain) : plain
}
