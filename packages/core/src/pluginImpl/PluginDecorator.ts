import 'reflect-metadata'
import type {
	PluginConstructor,
	PluginIdentifier,
	SubclassOf,
	Identifier,
} from './types'
import { BasePlugin } from './BasePlugin'

/** —— Symbols —— */
export const PLUGIN_SYMBOL = {
	META_KEY: Symbol.for('pluxel:meta'),
	CONFIG_MAP: Symbol.for('pluxel:config'),
	OPTIONAL_PARAMS_KEY: Symbol.for('pluxel:params'),
	BASE_CLASS: Symbol.for('pluxel:base'),
	PARAM_TOKENS: Symbol.for('pluxel:paramTokens'), // 👈 新增：构造参数覆盖（类级持久）
} as const

/** —— 元数据 —— */
export interface PluginMetadata {
	name: string
	type?: 'event' | 'hook' | string
	[key: string]: any
}
export type ConfigSchemaList<T = any> = Record<string, T>

/**
 * @Plugin 重载：
 * - 兼容：@Plugin(meta)
 * - 多态：@Plugin(base, meta) 其中 base: PluginIdentifier
 *   编译期要求：base extends BasePlugin；被装饰类 extends base
 */
export function Plugin(meta: PluginMetadata): ClassDecorator
export function Plugin<B extends PluginIdentifier>(
	base: B,
	meta: PluginMetadata,
): <C extends SubclassOf<B>>(ctor: C) => void
export function Plugin(
	a: PluginMetadata | PluginIdentifier,
	b?: PluginMetadata,
) {
	const hasBase = typeof a === 'function'
	const meta: PluginMetadata = (hasBase ? b : a) as PluginMetadata
	const base: PluginIdentifier | undefined = (hasBase ? a : undefined) as
		| PluginIdentifier
		| undefined

	return (ctor: Function) => {
		if (base) {
			// —— 运行时双保险 —— //
			// 1) base 必须继承 BasePlugin
			if (!isSubclassOf(base as Function, BasePlugin)) {
				throw new Error(
					`@Plugin(${getName(base)}) 失败：指定的抽象基类未继承 BasePlugin`,
				)
			}
			// 2) ctor 必须继承 base
			if (!isSubclassOf(ctor, base as Function)) {
				throw new Error(
					`@Plugin(${getName(base)}) 失败：${getName(ctor)} 未继承 ${getName(base)}`,
				)
			}
			Reflect.defineMetadata(PLUGIN_SYMBOL.BASE_CLASS, base, ctor)
		}
		// 冻结以避免外部后续改写
		Reflect.defineMetadata(
			PLUGIN_SYMBOL.META_KEY,
			Object.freeze({ ...meta }),
			ctor,
		)
	}
}

/** —— 配置字段装饰器（key 受实例类型约束） —— */
export function Config<S extends ConfigSchemaList>(
	schema: S,
): PropertyDecorator {
	return (target: object, propertyKey: string | symbol): void => {
		// —— 只允许实例字段（非 static）——
		if (typeof target === 'function') {
			// static 字段时 target 是构造函数
			throw new Error('@Config 只能用于实例字段(非 static)')
		}

		const ctor = (target as any).constructor as Function
		const prev: ConfigSchemaList =
			Reflect.getOwnMetadata(PLUGIN_SYMBOL.CONFIG_MAP, ctor) ??
			Object.create(null)
		prev[String(propertyKey)] = schema
		Reflect.defineMetadata(PLUGIN_SYMBOL.CONFIG_MAP, prev, ctor)
	}
}

/** —— 参数可选 —— */
export function Optional(): ParameterDecorator {
	return (target, propertyKey, parameterIndex) => {
		if (propertyKey !== undefined) {
			throw new Error('@Optional 只能用于构造函数参数')
		}
		const ctor = target as Function
		const existing: number[] =
			Reflect.getOwnMetadata(PLUGIN_SYMBOL.OPTIONAL_PARAMS_KEY, ctor) ?? []
		if (!existing.includes(parameterIndex)) existing.push(parameterIndex)
		Reflect.defineMetadata(PLUGIN_SYMBOL.OPTIONAL_PARAMS_KEY, existing, ctor)
	}
}

/** —— 读取工具 —— */
export interface MetadataMap {
	META_KEY: PluginMetadata
	CONFIG_MAP: ConfigSchemaList
	OPTIONAL_PARAMS_KEY: number[]
	BASE_CLASS: PluginIdentifier | undefined
	PARAM_TOKENS: ParamOverride | undefined
}
export function getPluginMeta<K extends keyof typeof PLUGIN_SYMBOL>(
	key: K,
	target: Function,
): MetadataMap[K] | undefined {
	return Reflect.getMetadata(PLUGIN_SYMBOL[key], target)
}
export function getBaseClass(target: Function): PluginIdentifier | undefined {
	return Reflect.getMetadata(PLUGIN_SYMBOL.BASE_CLASS, target)
}

/** —— 设计时参数类型（仅反射，不做业务收窄） —— */
export const PARAM_TYPES = 'design:paramtypes' as const

/** 覆盖类型（稀疏数组或索引表写法） */
export type ParamOverride =
	| ReadonlyArray<Identifier<any> | undefined>
	| Partial<Record<number, Identifier<any>>>

/**
 * 获取构造参数“令牌列表”
 * 优先级：一次性覆盖(override) > 持久覆盖(metadata) > 设计期反射
 */
export function getClassParam(
	target: Function,
	override?: ParamOverride, // 👈 一次性覆盖（只影响本次调用）
): readonly unknown[] {
	const reflected: unknown[] = Reflect.getMetadata(PARAM_TYPES, target) ?? []
	const tokens = Array.from(reflected) // 拷贝，避免外部修改污染缓存

	// 合并类级持久覆盖
	const stored: ParamOverride | undefined = Reflect.getOwnMetadata(
		PLUGIN_SYMBOL.PARAM_TOKENS,
		target,
	)

	applyOverride(tokens, stored)
	applyOverride(tokens, override)

	return Object.freeze(tokens)
}

/** —— 便捷筛选：精确匹配 / 祖先放宽 —— */
export function isPluginOf<B extends PluginIdentifier>(
	ctor: Function,
	base: B,
	/** deep=true 时，允许 BASE_CLASS 是 base 的子类 */
	deep = false,
): boolean {
	const tagged = getBaseClass(ctor)
	if (!tagged) return false
	return deep
		? isSubclassOf(tagged as Function, base as Function)
		: tagged === base
}
export function filterPluginsOf<B extends PluginIdentifier>(
	list: Function[],
	base: B,
	deep = false,
) {
	return list.filter((c) => isPluginOf(c, base, deep)) as SubclassOf<B>[]
}

/** —— 外部可手动调用的“类级持久覆盖” API —— */

/** 将第 index 个参数持久绑定到指定 token（写入 metadata） */
export function setParamToken(
	ctor: Function,
	index: number,
	token: Identifier<any>,
): void {
	const arr: Array<Identifier<any> | undefined> =
		Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor) ?? []
	if (index >= arr.length) arr.length = index + 1
	arr[index] = token
	Reflect.defineMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, arr, ctor)
}

/** 批量持久覆盖（稀疏数组或索引表写法） */
export function setParamTokens(ctor: Function, override: ParamOverride): void {
	const current: Array<Identifier<any> | undefined> =
		Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor) ?? []
	const next = current.slice()
	applyOverride(next, override)
	Reflect.defineMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, next, ctor)
}

/** 删除某个下标的持久覆盖 */
export function clearParamToken(ctor: Function, index: number): void {
	const arr: Array<Identifier<any> | undefined> =
		Reflect.getOwnMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor) ?? []
	if (index < arr.length) {
		arr[index] = undefined
		// 收尾连续的 undefined
		let end = arr.length
		while (end > 0 && arr[end - 1] === undefined) end--
		arr.length = end
	}
	Reflect.defineMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, arr, ctor)
}

/** 清空全部持久覆盖 */
export function clearParamTokens(ctor: Function): void {
	Reflect.deleteMetadata(PLUGIN_SYMBOL.PARAM_TOKENS, ctor)
}

/** —— 内部工具 —— */
function isSubclassOf(ctor: Function, base: Function): boolean {
	if (typeof ctor !== 'function' || typeof base !== 'function') return false
	const cp = (ctor as any).prototype
	const bp = (base as any).prototype
	// biome-ignore lint/suspicious/noPrototypeBuiltins: <explanation>
	return !!(cp && bp && bp.isPrototypeOf(cp))
}
function getName(fn: any): string {
	// biome-ignore lint/complexity/useOptionalChain: <explanation>
	return (fn && fn.name) || '<anonymous>'
}
function applyOverride(base: unknown[], override?: ParamOverride): void {
	if (!override) return
	if (Array.isArray(override)) {
		for (let i = 0; i < override.length; i++) {
			const v = override[i]
			if (v !== undefined) base[i] = v
		}
	} else {
		for (const k of Object.keys(override)) {
			const i = Number(k)
			const v = (override as Record<number, unknown>)[i]
			if (v !== undefined) base[i] = v
		}
	}
}
