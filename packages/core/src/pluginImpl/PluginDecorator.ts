import 'reflect-metadata'
import type { PluginClass, PluginIdentifier } from './types'

/**
 * 聚合所有元数据 Symbol
 */
export const PLUGIN_SYMBOL = {
	META_KEY: Symbol.for('pluxel:meta'),
	CONFIG_MAP: Symbol.for('pluxel:config'),
	OPTIONAL_PARAMS_KEY: Symbol.for('pluxel:params'),
} as const

type PluginConstructor = PluginClass

/**
 * 插件元数据接口
 */
export interface PluginMetadata {
	name: string
	type: 'event' | 'hook' | string
	[key: string]: any
}

export type ConfigSchema = Record<string, unknown>
export type ConfigList = Record<string, any>

/**
 * ClassDecorator: 注册插件元数据
 */
export function Plugin<T extends PluginConstructor>(meta: PluginMetadata) {
	return <U extends T>(constructorFunction: U) => {
		Reflect.defineMetadata(PLUGIN_SYMBOL.META_KEY, meta, constructorFunction)
	}
}

export function Config<S extends ConfigSchema>(schema: S) {
	return <T extends PluginConstructor>(
		target: T['prototype'],
		propertyKey: string | symbol,
	): void => {
		const ctor = (target as any).constructor as T
		const cfg: ConfigList =
			Reflect.getOwnMetadata(PLUGIN_SYMBOL.CONFIG_MAP, ctor) ||
			Object.create(null)

		cfg[String(propertyKey)] = schema

		Reflect.defineMetadata(PLUGIN_SYMBOL.CONFIG_MAP, cfg, ctor)
	}
}

/**
 * ParameterDecorator: 标记构造函数参数为可选
 */
export function Optional(): ParameterDecorator {
	return (
		target: Object,
		propertyKey: string | symbol | undefined,
		parameterIndex: number,
	) => {
		if (propertyKey !== undefined) {
			throw new Error('@Optional 只能用于构造函数参数')
		}
		const ctor = target as Function
		const existing: number[] =
			Reflect.getOwnMetadata(PLUGIN_SYMBOL.OPTIONAL_PARAMS_KEY, ctor) || []
		const updated = existing.includes(parameterIndex)
			? existing
			: [...existing, parameterIndex]
		Reflect.defineMetadata(PLUGIN_SYMBOL.OPTIONAL_PARAMS_KEY, updated, ctor)
	}
}

/**
 * 通用元数据读取函数：通过 Symbol 获取对应类型的数据
 */
/**
 * 元数据类型映射：根据键名映射到具体类型
 */
export interface MetadataMap {
	META_KEY: PluginMetadata
	CONFIG_MAP: ConfigList
	OPTIONAL_PARAMS_KEY: number[]
}
/**
 * 通用元数据读取：通过键名（字符串）获取对应类型数据，无需导入 Symbol
 */
export function getPluginMeta<K extends keyof typeof PLUGIN_SYMBOL>(
	key: K,
	target: Function,
): MetadataMap[K] | undefined {
	const sym = PLUGIN_SYMBOL[key]
	return Reflect.getMetadata(sym, target)
}

export const PARAM_TYPES = 'design:paramtypes'
export function getClassParam(target: Function): PluginIdentifier[] {
	return Reflect.getMetadata(PARAM_TYPES, target) || []
}
