import type { Identifier } from '../../../container'
import { isStandardSchemaV1 } from '../../../services/config/standardSchema'
import type { PluginIdentifier, SubclassOf } from '../../types'
import {
	__DEV__,
	$freeze,
	type AnyCtor,
	applyOverride,
	bumpTokens,
	EMPTY_ARR,
	isSubclassOf,
	nameOf,
	normalizeConfigSourceMap,
	normalizeId,
	rebuildInfoSnapshot,
	resolveCtorFromDecoratorTarget,
	S,
	STATE,
	sparseObjectToArray,
} from './shared'
import type { ParamOverride, PluginInfo } from './types'

/*───────────────────────────────────────────────────────────
  Identity APIs：外部可设置身份信息
───────────────────────────────────────────────────────────*/

/** 获取声明期原始名（不可变） */
export function getDeclaredName(ctor: AnyCtor): string {
	const s = STATE.get(ctor)
	return s?.declaredName || nameOf(ctor)
}

/** 获取系统 ID（考虑 loader 设置） */
export function getPluginId(ctor: AnyCtor): string {
	const s = STATE.get(ctor)
	return s ? normalizeId(s.id, s.declaredName || nameOf(ctor)) : nameOf(ctor)
}

/** 获取显示名 */
export function getDisplayName(ctor: AnyCtor): string {
	const s = STATE.get(ctor)
	if (!s) return nameOf(ctor)
	const declaredName = s.declaredName || nameOf(ctor)
	const id = normalizeId(s.id, declaredName)
	return s.displayName?.trim() || id
}

/** 获取包名 */
export function getPackageName(ctor: AnyCtor): string | null {
	return STATE.get(ctor)?.packageName ?? null
}

/** 设置系统 ID（通常由 loader 调用） */
export function setPluginId(ctor: AnyCtor, id: string): void {
	const s = S(ctor)
	s.id = normalizeId(id, s.declaredName || nameOf(ctor))
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** 设置显示名 */
export function setDisplayName(ctor: AnyCtor, name: string | null): void {
	const s = S(ctor)
	s.displayName = name
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** 设置包名（通常由 loader 调用） */
export function setPackageName(ctor: AnyCtor, name: string | null): void {
	const s = S(ctor)
	s.packageName = name
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/**
 * 批量设置身份信息（减少多次 rebuild）
 */
export function setPluginIdentity(
	ctor: AnyCtor,
	identity: { id?: string; displayName?: string | null; packageName?: string | null },
): void {
	const s = S(ctor)
	if (identity.id !== undefined) s.id = normalizeId(identity.id, s.declaredName || nameOf(ctor))
	if (identity.displayName !== undefined) s.displayName = identity.displayName
	if (identity.packageName !== undefined) s.packageName = identity.packageName
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

/** @deprecated 使用 getPluginId 代替 */
export function getEffectiveName(ctor: AnyCtor): string {
	return getPluginId(ctor)
}

/*───────────────────────────────────────────────────────────
  Read APIs
───────────────────────────────────────────────────────────*/

export function checkPluginDecorator(ctor: AnyCtor): boolean {
	const s = STATE.get(ctor)
	return !!s?.infoSnap
}

export function getPluginInfo(ctor: AnyCtor): PluginInfo {
	const s = STATE.get(ctor)
	if (!s || !s.infoSnap) {
		throw new Error(`getPluginInfo(${nameOf(ctor)}) 在未装饰的类上被调用，请先使用 @Plugin`)
	}
	return s.infoSnap
}

export function getBaseClass(target: AnyCtor): PluginIdentifier | null {
	return STATE.get(target)?.base ?? null
}

export function resolvePluginRoot(id: PluginIdentifier): PluginIdentifier {
	if (typeof id !== 'function') return id
	let cur = id as unknown as AnyCtor
	const seen = new Set<AnyCtor>()
	while (typeof cur === 'function') {
		if (seen.has(cur)) break
		seen.add(cur)
		const base = STATE.get(cur)?.base
		if (!base || base === cur) break
		if (typeof base !== 'function') break
		cur = base as unknown as AnyCtor
	}
	return cur as PluginIdentifier
}

export function isPluginOf<B extends PluginIdentifier>(
	ctor: AnyCtor,
	base: B,
	deep = false,
): boolean {
	const tagged = getBaseClass(ctor)
	if (!tagged) return false
	if (!deep) return tagged === base
	if (typeof tagged !== 'function' || typeof base !== 'function') return false
	return isSubclassOf(tagged as unknown as AnyCtor, base as unknown as AnyCtor)
}

export function filterPluginsOf<B extends PluginIdentifier>(
	list: AnyCtor[],
	base: B,
	deep = false,
) {
	return list.filter((c) => isPluginOf(c, base, deep)) as SubclassOf<B>[]
}

/*───────────────────────────────────────────────────────────
  Hot Path：构造参数解析
───────────────────────────────────────────────────────────*/

export function getClassParams<T = unknown>(
	target: AnyCtor,
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

export function requirePluginDependency(target: object | AnyCtor, dep: PluginIdentifier): void {
	const ctor = resolveCtorFromDecoratorTarget(target)
	if (ctor === dep) return

	const s = S(ctor)
	const cur = s.requiredDeps
	if (cur?.includes(dep)) return
	const next = cur ? cur.slice() : []
	next.push(dep)
	s.requiredDeps = next
}

export function getRequiredPluginDependencies(
	ctor: AnyCtor,
	opts?: { inherit?: boolean },
): ReadonlyArray<PluginIdentifier> {
	const inherit = !!opts?.inherit

	const out: PluginIdentifier[] = []
	const seen = new Set<PluginIdentifier>()
	const visited = new Set<AnyCtor>()

	let cur: AnyCtor | null = ctor
	while (typeof cur === 'function' && cur && !visited.has(cur)) {
		visited.add(cur)
		const deps = STATE.get(cur)?.requiredDeps
		if (deps?.length) {
			for (let i = 0; i < deps.length; i++) {
				const dep = deps[i]!
				if (seen.has(dep)) continue
				seen.add(dep)
				out.push(dep)
			}
		}

		if (!inherit) break
		const proto =
			(cur as { prototype?: unknown }).prototype != null
				? Object.getPrototypeOf((cur as { prototype?: unknown }).prototype)
				: null
		if (!proto || proto === Object.prototype) break
		const nextCtor = (proto as { constructor?: unknown }).constructor
		if (typeof nextCtor !== 'function') break
		cur = nextCtor as unknown as AnyCtor
	}

	return __DEV__ ? $freeze(out) : out
}

/*───────────────────────────────────────────────────────────
  Feature composition metadata (plan A)
───────────────────────────────────────────────────────────*/

export function useFeature(target: AnyCtor, feature: AnyCtor): void {
	const s = S(target)
	const cur = s.features
	if (cur?.includes(feature)) return
	const next = cur ? cur.slice() : []
	next.push(feature)
	s.features = __DEV__ ? $freeze(next) : next
}

export function getUsedFeatures(ctor: AnyCtor): ReadonlyArray<AnyCtor> {
	return (STATE.get(ctor)?.features ?? EMPTY_ARR) as ReadonlyArray<AnyCtor>
}

export function getDeclaredConfigKeys(ctor: AnyCtor): string[] {
	const s = STATE.get(ctor)
	const map = (s?.config ?? s?.pending) as Record<string, unknown> | null | undefined
	return map ? Object.keys(map) : []
}

export function getFeatureNamespace(feature: AnyCtor): string {
	const raw =
		(feature as unknown as { featureKey?: unknown }).featureKey ??
		(feature as unknown as { featureNamespace?: unknown }).featureNamespace ??
		getDeclaredName(feature)
	const ns = typeof raw === 'string' ? raw.trim() : ''
	if (!ns) throw new Error(`[UseFeature] feature namespace is empty for ${nameOf(feature)}`)
	return ns
}

function applyFeatureComposition(
	ctor: AnyCtor,
	feature: AnyCtor,
	opts?: { rebuild?: boolean },
): void {
	const s = S(ctor)
	if (s.features?.includes(feature)) return

	useFeature(ctor, feature)
	const deps = getRequiredPluginDependencies(feature, { inherit: true })
	for (let i = 0; i < deps.length; i++) requirePluginDependency(ctor, deps[i]!)

	const finalized = !!s.infoSnap

	// Merge feature @Config fields into the host plugin config as a namespaced set of keys.
	// - key format: `${featureNamespace}.${fieldName}`
	// - ensures feature configs "belong" to the host plugin panel without collisions.
	const fs = STATE.get(feature)
	const featureConfig = (fs?.config ?? fs?.pending) as Record<string, unknown> | null | undefined
	if (featureConfig && Object.keys(featureConfig).length) {
		const ns = getFeatureNamespace(feature)
		const dst = (
			finalized ? (s.config ?? Object.create(null)) : (s.pending ?? Object.create(null))
		) as Record<string, unknown>
		const next = Object.assign(Object.create(null), dst)
		for (const fieldName of Object.keys(featureConfig)) {
			const key = `${ns}.${fieldName}`
			if (key in next) {
				throw new Error(
					`[UseFeature] config key collision on ${nameOf(ctor)}: ${key} (from feature ${nameOf(
						feature,
					)})`,
				)
			}
			next[key] = featureConfig[fieldName]
		}
		if (finalized) s.config = __DEV__ ? $freeze(next) : next
		else s.pending = next
	}

	const featureSource = fs?.configSource
	if (featureSource && Object.keys(featureSource).length) {
		const ns = getFeatureNamespace(feature)
		const dst = (s.configSource ?? Object.create(null)) as Record<string, string>
		const next = Object.assign(Object.create(null), dst)
		for (const fieldName of Object.keys(featureSource)) {
			const key = `${ns}.${fieldName}`
			if (key in next) {
				throw new Error(
					`[UseFeature] configSource key collision on ${nameOf(ctor)}: ${key} (from feature ${nameOf(
						feature,
					)})`,
				)
			}
			next[key] = featureSource[fieldName]!
		}
		s.configSource = next
	}

	if (finalized && opts?.rebuild !== false) rebuildInfoSnapshot(ctor, s)
}

export function __registerUsedFeature__(ctor: AnyCtor, feature: AnyCtor): void {
	__registerUsedFeatures__(ctor, feature)
}

export function __registerUsedFeatures__(ctor: AnyCtor, ...features: AnyCtor[]): void {
	if (!features || features.length === 0) return
	for (let i = 0; i < features.length; i++) {
		applyFeatureComposition(ctor, features[i]!, { rebuild: false })
	}
	const s = STATE.get(ctor)
	if (s?.infoSnap) rebuildInfoSnapshot(ctor, S(ctor))
}

/**
 * Declare that a plugin composes a feature:
 * - records the feature ctor on the plugin definition;
 * - propagates decorator-required plugin deps from the feature onto the plugin,
 *   so DI validation stays deterministic.
 */
export function UseFeature(...features: AnyCtor[]): ClassDecorator {
	return (ctor) => {
		__registerUsedFeatures__(ctor as unknown as AnyCtor, ...features)
	}
}

/*───────────────────────────────────────────────────────────
  Tokens：持久覆盖（写入即失效；不影响身份数据）
───────────────────────────────────────────────────────────*/

export function setParamToken(ctor: AnyCtor, index: number, token: Identifier<unknown>): void {
	const s = S(ctor)
	const next = s.tokens ? s.tokens.slice() : []
	if (index >= next.length) next.length = index + 1
	next[index] = token
	s.tokens = next
	bumpTokens(s)
}

export function setParamTokens(ctor: AnyCtor, override: ParamOverride): void {
	const s = S(ctor)
	const base = s.tokens ? s.tokens.slice() : []
	if (Array.isArray(override)) applyOverride(base, override)
	else
		applyOverride(
			base,
			sparseObjectToArray(override as unknown as Readonly<Record<number, Identifier<unknown>>>),
		)
	s.tokens = base
	bumpTokens(s)
}

export function clearParamToken(ctor: AnyCtor, index: number): void {
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

export function clearParamTokens(ctor: AnyCtor): void {
	const s = S(ctor)
	if (!s.tokens) return
	s.tokens = null
	bumpTokens(s)
}

/** 只读观察当前 tokens 视图（拷贝；DEV 下冻结） */
export function getStoredParamTokens(
	ctor: AnyCtor,
): ReadonlyArray<Identifier<unknown> | undefined> | undefined {
	const t = STATE.get(ctor)?.tokens
	if (!t) return undefined
	const copy = t.slice()
	return __DEV__ ? $freeze(copy) : copy
}

/*───────────────────────────────────────────────────────────
  Config Source：Vite 插件注入的 @Config 源代码
───────────────────────────────────────────────────────────*/

export function __setConfigSource__(ctor: AnyCtor, fieldName: string, source: string): void {
	const s = S(ctor)
	const bucket = s.configSource ?? Object.create(null)
	bucket[fieldName] = source
	s.configSource = bucket
	if (s.infoSnap) rebuildInfoSnapshot(ctor, s)
}

export function __registerConfigSchema__(ctor: AnyCtor, fieldName: string, schema: unknown): void {
	const s = S(ctor)
	if (!isStandardSchemaV1(schema)) {
		throw new Error(
			`Invalid config schema: "${ctor.name}.${fieldName}" must implement Standard Schema v1 (~standard.validate).`,
		)
	}

	// Feature classes are not decorated with @Plugin; keep their schemas in `pending`.
	if (!s.infoSnap) {
		const bucket = (s.pending ?? Object.create(null)) as Record<string, unknown>
		bucket[fieldName] = schema
		s.pending = bucket
		return
	}

	const dst = (s.config ?? Object.create(null)) as Record<string, unknown>
	if (dst[fieldName] === schema) return

	const next = Object.assign(Object.create(null), dst)
	next[fieldName] = schema
	s.config = __DEV__ ? $freeze(next) : next
	rebuildInfoSnapshot(ctor, s)
}

export function getConfigSource(ctor: AnyCtor): Readonly<Record<string, string>> | null {
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
	const src = typeof from === 'function' ? STATE.get(from as unknown as AnyCtor) : undefined
	if (!src || !src.infoSnap) {
		throw new Error(`clonePluginDefinition(${String(from)}) 失败：源类未装饰 @Plugin`)
	}
	if (typeof to !== 'function') {
		throw new Error(`clonePluginDefinition(${String(from)}) 失败：目标不是可装饰的类`)
	}
	const dst = S(to as unknown as AnyCtor)

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

	rebuildInfoSnapshot(to as unknown as AnyCtor, dst)
}
