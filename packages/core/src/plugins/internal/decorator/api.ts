import type { Identifier, PluginIdentifier, SubclassOf } from '../types'
import type { ParamOverride, PluginInfo } from './types'
import {
	STATE,
	S,
	$freeze,
	__DEV__,
	applyOverride,
	bumpTokens,
	isSubclassOf,
	nameOf,
	normalizeConfigSourceMap,
	normalizeId,
	rebuildInfoSnapshot,
	resolveCtorFromDecoratorTarget,
	sparseObjectToArray,
} from './shared'

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
	return s ? normalizeId(s.id, s.declaredName || nameOf(ctor)) : nameOf(ctor)
}

/** 获取显示名 */
export function getDisplayName(ctor: Function): string {
	const s = STATE.get(ctor)
	if (!s) return nameOf(ctor)
	const declaredName = s.declaredName || nameOf(ctor)
	const id = normalizeId(s.id, declaredName)
	return s.displayName?.trim() || id
}

/** 获取包名 */
export function getPackageName(ctor: Function): string | null {
	return STATE.get(ctor)?.packageName ?? null
}

/** 设置系统 ID（通常由 loader 调用） */
export function setPluginId(ctor: Function, id: string): void {
	const s = S(ctor)
	s.id = normalizeId(id, s.declaredName || nameOf(ctor))
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
	identity: { id?: string; displayName?: string | null; packageName?: string | null },
): void {
	const s = S(ctor)
	if (identity.id !== undefined) s.id = normalizeId(identity.id, s.declaredName || nameOf(ctor))
	if (identity.displayName !== undefined) s.displayName = identity.displayName
	if (identity.packageName !== undefined) s.packageName = identity.packageName
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
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
	return !!s?.infoSnap
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
  External Decorator Support: required plugin deps
───────────────────────────────────────────────────────────*/

export function requirePluginDependency(target: object | Function, dep: PluginIdentifier): void {
	const ctor = resolveCtorFromDecoratorTarget(target)
	if (ctor === (dep as any)) return

	const s = S(ctor)
	const cur = s.requiredDeps
	if (cur && cur.includes(dep)) return
	const next = cur ? cur.slice() : []
	next.push(dep)
	s.requiredDeps = next
}

export function getRequiredPluginDependencies(
	ctor: Function,
	opts?: { inherit?: boolean },
): ReadonlyArray<PluginIdentifier> {
	const inherit = !!opts?.inherit

	const out: PluginIdentifier[] = []
	const seen = new Set<PluginIdentifier>()
	const visited = new Set<Function>()

	let cur: Function | null = ctor
	while (typeof cur === 'function' && cur && !visited.has(cur)) {
		visited.add(cur)
		const deps = STATE.get(cur)?.requiredDeps
		if (deps && deps.length) {
			for (let i = 0; i < deps.length; i++) {
				const dep = deps[i]!
				if (seen.has(dep)) continue
				seen.add(dep)
				out.push(dep)
			}
		}

		if (!inherit) break
		const proto = (cur as any)?.prototype ? Object.getPrototypeOf((cur as any).prototype) : null
		if (!proto || proto === Object.prototype) break
		cur = (proto as any).constructor as Function
	}

	return __DEV__ ? $freeze(out) : out
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

export function __setConfigSource__(ctor: Function, fieldName: string, source: string): void {
	const s = S(ctor)
	const bucket = s.configSource ?? Object.create(null)
	bucket[fieldName] = source
	s.configSource = bucket
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

export function getConfigSource(ctor: Function): Readonly<Record<string, string>> | null {
	const s = STATE.get(ctor)
	return normalizeConfigSourceMap(s?.configSource ?? null)
}

/*───────────────────────────────────────────────────────────
  Fork Support
───────────────────────────────────────────────────────────*/

export function clonePluginDefinition(
	from: PluginIdentifier,
	to: PluginIdentifier,
	identity?: { id?: string | null; displayName?: string | null; packageName?: string | null },
): void {
	const src = STATE.get(from as unknown as Function)
	if (!src || !src.infoSnap) {
		throw new Error(`clonePluginDefinition(${nameOf(from)}) 失败：源类未装饰 @Plugin`)
	}
	const dst = S(to as unknown as Function)

	// cold/immutable data
	dst.declaredMeta = src.declaredMeta
	dst.declaredName = src.declaredName
	dst.base = src.base
	dst.config = src.config
	dst.configSource = src.configSource
	dst.rtypes = src.rtypes

	// identity (override allowed)
	dst.id = identity?.id ?? src.id
	dst.displayName = identity?.displayName ?? src.displayName
	dst.packageName = identity?.packageName ?? src.packageName

	// persistent tokens: share array reference (writers always copy on write)
	dst.tokens = src.tokens
	dst.epoch = src.epoch
	dst.paramCache = null
	dst.paramCacheEpoch = -1

	// fork ctor becomes the runtime class
	dst.ctor = to
	dst.pending = null

	rebuildInfoSnapshot(to as unknown as Function, dst)
}
