import { isProduction } from '../../../env'
import type { Identifier } from '../../../container'
import type { PluginIdentifier } from '../../types'
import { assertValidBasePluginId, assertValidPluginId } from '../../runtime/pluginId'
import type { ConfigSchemaList, DeclaredMetaView, ParamOverride, PluginInfo } from './types'
import type { ConfigLayout } from '../../composition/cfg'

/*───────────────────────────────────────────────────────────
  Runtime Policy
  - DEV: 冻结返回值/快照，尽早暴露"误改"。
  - PROD: 不冻结，避免隐藏类固定/写屏障。
  - 热路径 = 1× WeakMap.get → 固定 shape 的 State 属性访问。
───────────────────────────────────────────────────────────*/
export const __DEV__ =
	typeof (globalThis as unknown as { __PLUXEL_DEV__?: unknown }).__PLUXEL_DEV__ === 'boolean'
		? (globalThis as unknown as { __PLUXEL_DEV__: boolean }).__PLUXEL_DEV__
		: !isProduction
export const $freeze = <T>(x: T): T => (__DEV__ ? Object.freeze(x) : x)
export const EMPTY_ARR: readonly unknown[] = $freeze([])

export type AnyCtor = Function & (abstract new (...args: any[]) => any)

/*───────────────────────────────────────────────────────────
  Internal State（单 WM，固定 shape，JIT 友好）
  所有字段使用 null 而非 undefined（V8 优化）
───────────────────────────────────────────────────────────*/
type Tokens = Array<Identifier<unknown> | undefined>

export interface State {
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
	/** Optional config layout (bindingField -> layout parts) */
	configLayout: Record<string, ConfigLayout> | null
	/** Config injection bindings: instanceField -> config keys */
	configBindings: Record<string, readonly string[]> | null
	/** 预取的设计期构造参数类型（热路径不再触碰 Reflect） */
	rtypes: readonly unknown[]
	/** 插件类引用 */
	ctor: PluginIdentifier | null
	/** 由第三方 decorator 声明的“需要的插件依赖”（用于校验显式 ctor 依赖） */
	requiredDeps: ReadonlyArray<PluginIdentifier> | null
	/** Feature composition: feature ctors declared on this plugin. */
	features: ReadonlyArray<AnyCtor> | null

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

export const STATE = new WeakMap<AnyCtor, State>()

/** 获取或创建 State（固定 shape，JIT 友好） */
export const S = (ctor: AnyCtor): State => {
	let s = STATE.get(ctor)
	if (s) return s
	// 所有字段显式初始化为 null，保持固定 shape
	s = {
		declaredMeta: null,
		declaredName: null,
		base: null,
		config: null,
		configSource: null,
		configLayout: null,
		configBindings: null,
		rtypes: EMPTY_ARR,
		ctor: null,
		requiredDeps: null,
		features: null,

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
export const nameOf = (fn: { name?: string } | null | undefined): string =>
	fn?.name || '<anonymous>'

export const isSubclassOf = (ctor: AnyCtor, base: AnyCtor): boolean => {
	if (ctor === base) return true
	if (typeof ctor !== 'function' || typeof base !== 'function') return false
	const cp = (ctor as { prototype?: object }).prototype
	const bp = (base as { prototype?: object }).prototype
	return Boolean(cp && bp && Object.prototype.isPrototypeOf.call(bp, cp))
}

export const resolveCtorFromDecoratorTarget = (target: object | AnyCtor): AnyCtor => {
	if (typeof target === 'function') return target as AnyCtor
	const ctor = (target as { constructor?: unknown }).constructor
	if (typeof ctor !== 'function')
		throw new Error('[PluginDecorator] 无法从 decorator target 解析 ctor')
	return ctor as AnyCtor
}

/** tokens 变更 → 仅失效构造参数缓存（与身份数据无关） */
export const bumpTokens = (s: State): void => {
	s.epoch++
	s.paramCache = null
	s.paramCacheEpoch = -1
}

/*───────────────────────────────────────────────────────────
  Snapshot Builder
───────────────────────────────────────────────────────────*/

export const normalizeId = (raw: string | null | undefined, declaredName: string): string => {
	// 空/空白 ID 都视为错误：插件必须拥有稳定的系统标识符
	const id = (raw ?? declaredName).trim()
	if (!id) {
		throw new Error(`[PluginDecorator] 插件 "${declaredName}" 缺少有效 id`)
	}
	// Keep id semantics centralized (fork ids, base ids, ASCII rules).
	// This intentionally enforces a strict naming policy across host implementations.
	if (raw == null) assertValidBasePluginId(id)
	else assertValidPluginId(id)
	return id
}

export function normalizeConfigSourceMap(
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

function freezeLayout(layout: ConfigLayout): ConfigLayout {
	if (!__DEV__) return layout
	// Freeze shallowly for safety; parts are plain objects.
	const next = layout.map((p) => (p && typeof p === 'object' ? Object.freeze({ ...(p as any) }) : p)) as any
	return Object.freeze(next) as any
}

export function normalizeConfigLayoutMap(
	layout: Record<string, ConfigLayout> | null,
): Readonly<Record<string, ConfigLayout>> | null {
	if (!layout || !Object.keys(layout).length) return null
	const proto = Object.getPrototypeOf(layout)
	if (!__DEV__ && proto === Object.prototype) {
		return layout as Readonly<Record<string, ConfigLayout>>
	}
	const plain: Record<string, ConfigLayout> = { ...layout }
	if (__DEV__) {
		for (const [k, v] of Object.entries(plain)) {
			if (!Array.isArray(v)) continue
			plain[k] = freezeLayout(v)
		}
		return $freeze(plain)
	}
	return plain
}

export function normalizeConfigBindingsMap(
	bindings: Record<string, readonly string[]> | null,
): Readonly<Record<string, readonly string[]>> | null {
	if (!bindings || !Object.keys(bindings).length) return null
	const proto = Object.getPrototypeOf(bindings)
	if (!__DEV__ && proto === Object.prototype) {
		return bindings as Readonly<Record<string, readonly string[]>>
	}
	const plain: Record<string, readonly string[]> = { ...bindings }
	return __DEV__ ? $freeze(plain) : plain
}

/** 重建对外快照（不动 epoch） */
export function rebuildInfoSnapshot(ctor: AnyCtor, s: State): void {
	const declaredName = s.declaredName || nameOf(ctor)
	const id = normalizeId(s.id, declaredName)
	const displayName = s.displayName?.trim() || id

	const configSourceMap =
		s.configSource && Object.keys(s.configSource).length
			? normalizeConfigSourceMap(s.configSource)
			: null
	const configLayoutMap =
		s.configLayout && Object.keys(s.configLayout).length
			? normalizeConfigLayoutMap(s.configLayout)
			: null
	const configBindingsMap =
		s.configBindings && Object.keys(s.configBindings).length
			? normalizeConfigBindingsMap(s.configBindings)
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
		configLayoutMap,
		configBindingsMap,
	}

	s.infoSnap = __DEV__ ? $freeze(snap) : snap
}

/*───────────────────────────────────────────────────────────
  Params helpers
───────────────────────────────────────────────────────────*/

export function applyOverride(dst: unknown[], override?: ParamOverride): void {
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
			const v = (override as unknown as Record<string, Identifier<unknown>>)[String(idx)]
			if (v !== undefined) dst[idx] = v
		}
	}
}

export function sparseObjectToArray(
	o: Readonly<Record<number, Identifier<unknown>>>,
): Array<Identifier<unknown> | undefined> {
	const ks = Object.keys(o)
	if (!ks.length) return []
	let max = -1
	for (let i = 0; i < ks.length; i++) {
		const idx = (ks[i] as unknown as number) | 0
		if (idx > max) max = idx
	}
	const arr = new Array<Identifier<unknown> | undefined>(max + 1)
	for (let i = 0; i < ks.length; i++) {
		const idx = (ks[i] as unknown as number) | 0
		arr[idx] = (o as unknown as Record<string, Identifier<unknown>>)[String(idx)]
	}
	return arr
}
