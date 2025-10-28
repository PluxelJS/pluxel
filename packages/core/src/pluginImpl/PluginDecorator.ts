import 'reflect-metadata'
import { BasePlugin } from './BasePlugin'
import type { Identifier, PluginIdentifier, SubclassOf } from './types'

/** —— Public symbols —— */
export const PLUGIN_SYMBOL = {
	META_KEY: Symbol.for('pluxel:meta'),
	CONFIG_MAP: Symbol.for('pluxel:config'),
	BASE_CLASS: Symbol.for('pluxel:base'),
	PARAM_TOKENS: Symbol.for('pluxel:paramTokens'),
} as const

/** —— Internal symbols —— */
const CONFIG_PENDING = Symbol.for('pluxel:config:pending') // pending bucket for @Config
const TOKEN_EPOCH = Symbol.for('pluxel:paramTokens:epoch') // epoch for param view cache

/** —— Metadata —— */
export interface PluginMetadata {
	name: string
	[key: string]: any
}
export type ConfigSchemaList<T = any> = Record<string, T>

/** —— Reflection key for design-time types —— */
export const PARAM_TYPES = 'design:paramtypes' as const

/** —— Override type —— */
export type ParamOverride =
	| ReadonlyArray<Identifier<any> | undefined>
	| Partial<Record<number, Identifier<any>>>

/* =========================================================
 *                    @Plugin（收尾批量落盘）
 *   - @Plugin(meta)
 *   - @Plugin(base, meta)
 *   - 合并 pending @Config，一次 define + 冻结
 * =======================================================*/
function getName(fn: any): string {
	// biome-ignore lint/complexity/useOptionalChain: <explanation>
	return (fn && fn.name) || '<anonymous>'
}
export function Plugin(meta: PluginMetadata): ClassDecorator
export function Plugin<B extends PluginIdentifier>(
	base: B,
	meta: PluginMetadata,
): <C extends SubclassOf<B>>(ctor: C) => void
export function Plugin(a: PluginMetadata | PluginIdentifier, b?: PluginMetadata) {
	const hasBase = typeof a === 'function'
	const meta: PluginMetadata = (hasBase ? b : a) as PluginMetadata
	const base: PluginIdentifier | undefined = (hasBase ? a : undefined) as
		| PluginIdentifier
		| undefined

	return (ctor: Function) => {
		if (base) {
			if (!isSubclassOf(base as Function, BasePlugin)) {
				throw new Error(`@Plugin(${getName(base)}) 失败：抽象基类未继承 BasePlugin`)
			}
			if (!isSubclassOf(ctor, base as Function)) {
				throw new Error(`@Plugin(${getName(base)}) 失败：${getName(ctor)} 未继承 ${getName(base)}`)
			}
			Reflect.defineMetadata(PLUGIN_SYMBOL.BASE_CLASS, base, ctor)
		}

		Reflect.defineMetadata(PLUGIN_SYMBOL.META_KEY, Object.freeze({ ...meta }), ctor)

		// Flush pending @Config
		const pending: Map<string, unknown> | undefined = Reflect.getOwnMetadata(CONFIG_PENDING, ctor)
		// biome-ignore lint/complexity/useOptionalChain: <explanation>
		if (pending && pending.size) {
			const obj: Record<string, unknown> = Object.create(null)
			for (const [k, v] of pending) obj[k] = v
			Reflect.deleteMetadata(CONFIG_PENDING, ctor)
			Reflect.defineMetadata(PLUGIN_SYMBOL.CONFIG_MAP, Object.freeze(obj), ctor)
		}

		// Stable cache will be rebuilt on demand
		STABLE_CACHE.delete(ctor)
	}
}

/* =========================================================
 *                     @Config（定义期聚合）
 * =======================================================*/
export function Config<S extends ConfigSchemaList>(schema: S): PropertyDecorator {
	return (target: object, propertyKey: string | symbol): void => {
		if (typeof target === 'function') {
			throw new Error('@Config 只能用于实例字段(非 static)')
		}
		const ctor = (target as any).constructor as Function
		const bucket: Map<string, unknown> =
			Reflect.getOwnMetadata(CONFIG_PENDING, ctor) ?? new Map<string, unknown>()
		bucket.set(String(propertyKey), schema)
		Reflect.defineMetadata(CONFIG_PENDING, bucket, ctor)
	}
}

/* =========================================================
 *                  Stable info（独立缓存）
 *   meta / base / configMap
 * =======================================================*/
export interface StableInfo {
	readonly meta: PluginMetadata
	readonly base?: PluginIdentifier
	readonly configMap?: ConfigSchemaList
}
const STABLE_CACHE = new WeakMap<Function, Readonly<StableInfo>>()

export function getPluginInfo(ctor: Function): Readonly<StableInfo> | undefined {
	const c = STABLE_CACHE.get(ctor)
	if (c) return c

	const meta = Reflect.getOwnMetadata(PLUGIN_SYMBOL.META_KEY, ctor)
	if (meta === undefined) {
		return
	}
	const base = Reflect.getOwnMetadata(PLUGIN_SYMBOL.BASE_CLASS, ctor) as
		| PluginIdentifier
		| undefined
	const configMap = Reflect.getOwnMetadata(PLUGIN_SYMBOL.CONFIG_MAP, ctor) as
		| ConfigSchemaList
		| undefined

	const info: Readonly<StableInfo> = Object.freeze({
		meta,
		base,
		configMap,
	})
	STABLE_CACHE.set(ctor, info)
	return info
}

/* =========================================================
 *        getClassParam（与 stable 解耦 + 热缓存）
 *   顺序：design:paramtypes -> persistent tokens -> once override
 *   按 epoch 失效，仅在无 once override 时缓存
 * =======================================================*/
type ParamView = Readonly<{ epoch: number; params: readonly unknown[] }>
const PARAM_VIEW_CACHE = new WeakMap<Function, ParamView>()

export function getClassParam<T = unknown>(
	target: Function,
	override?: ParamOverride,
): readonly T[] {
	if (!override) {
		const epoch = currentEpoch(target)
		const c = PARAM_VIEW_CACHE.get(target)
		if (c && c.epoch === epoch) return c.params as any
	}

	const reflected: unknown[] = Reflect.getMetadata(PARAM_TYPES, target) ?? []
	const tokens = Array.from(reflected)

	const stored: ParamOverride | undefined = Reflect.getOwnMetadata(
		PLUGIN_SYMBOL.PARAM_TOKENS,
		target,
	)
	applyOverride(tokens, stored)
	applyOverride(tokens, override)

	const frozen = Object.freeze(tokens)
	if (!override) {
		PARAM_VIEW_CACHE.set(target, Object.freeze({ epoch: currentEpoch(target), params: frozen }))
	}
	return frozen as any
}

export function getBaseClass(target: Function): PluginIdentifier | undefined {
	return Reflect.getOwnMetadata(PLUGIN_SYMBOL.BASE_CLASS, target)
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

/* =========================================================
 *         Persistent overrides（写入即 bump epoch）
 * =======================================================*/
export function setParamToken(ctor: Function, index: number, token: Identifier<any>): void {
	const arr: Array<Identifier<any> | undefined> =
		Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor) ?? []
	if (index >= arr.length) arr.length = index + 1
	arr[index] = token
	Reflect.defineMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, arr, ctor)
	bumpEpoch(ctor)
}
export function setParamTokens(ctor: Function, override: ParamOverride): void {
	const current: Array<Identifier<any> | undefined> =
		Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor) ?? []
	const next = current.slice()
	applyOverride(next, override)
	Reflect.defineMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, next, ctor)
	bumpEpoch(ctor)
}
export function clearParamToken(ctor: Function, index: number): void {
	const arr: Array<Identifier<any> | undefined> =
		Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor) ?? []
	if (index < arr.length) {
		arr[index] = undefined
		let end = arr.length
		while (end > 0 && arr[end - 1] === undefined) end--
		arr.length = end
	}
	Reflect.defineMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, arr, ctor)
	bumpEpoch(ctor)
}
export function clearParamTokens(ctor: Function): void {
	Reflect.deleteMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor)
	bumpEpoch(ctor)
}

/* =========================================================
 *                      Internals
 * =======================================================*/
function isSubclassOf(ctor: Function, base: Function): boolean {
	if (ctor === base) return true
	if (typeof ctor !== 'function' || typeof base !== 'function') return false
	const cp = (ctor as any).prototype
	const bp = (base as any).prototype
	// biome-ignore lint/suspicious/noPrototypeBuiltins: <explanation>
	return !!(cp && bp && bp.isPrototypeOf(cp))
}

function applyOverride(base: unknown[], override?: ParamOverride): void {
	if (!override) return
	if (Array.isArray(override)) {
		for (let i = 0, n = override.length; i < n; i++) {
			const v = override[i]
			if (v !== undefined) base[i] = v
		}
	} else {
		for (const k in override) {
			const i = (k as unknown as number) | 0
			const v = (override as any)[i]
			if (v !== undefined) base[i] = v
		}
	}
}
/** max(reflected length, persistent override length) */
function _getParamLengthh(ctor: Function): number {
	const reflected: unknown[] = Reflect.getMetadata(PARAM_TYPES, ctor) ?? []
	const stored: ParamOverride | undefined = Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor)
	let toks = 0
	if (Array.isArray(stored)) {
		toks = stored.length
	} else if (stored && typeof stored === 'object') {
		let max = -1
		for (const k in stored) {
			const i = (k as unknown as number) | 0
			if (stored[i] !== undefined && i > max) max = i
		}
		toks = max + 1
	}
	return Math.max(reflected.length, toks)
}
/** epoch helpers */
function currentEpoch(ctor: Function): number {
	return Reflect.getOwnMetadata(TOKEN_EPOCH, ctor) ?? 0
}
function setEpoch(ctor: Function, n: number) {
	Reflect.defineMetadata(TOKEN_EPOCH, n, ctor)
}
function bumpEpoch(ctor: Function) {
	setEpoch(ctor, currentEpoch(ctor) + 1)
	PARAM_VIEW_CACHE.delete(ctor)
}
