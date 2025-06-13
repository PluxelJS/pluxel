// PluginDecorator.ts
import 'reflect-metadata'
import type { Newable, PluginClass } from './types'

export const PLUGIN_META_KEY = Symbol.for('pluxel:meta')
export const PLUGIN_CONFIG_MAP = Symbol.for('pluxel:config')
// 新增：Optional 装饰器 key
export const OPTIONAL_PARAMS_KEY = Symbol.for('pluxel:params')

export const PARAM_TYPES = 'design:paramtypes'

export interface PluginMetadata {
	name: string
	type: 'event' | 'hook' | string
	// 其他元数据可按需扩展
}

type TargetClass = PluginClass
export function getPluginMeta(target: TargetClass): PluginMetadata | undefined {
	return Reflect.getMetadata(PLUGIN_META_KEY, target)
}

export function Plugin(meta: PluginMetadata) {
	return (constructorFunction: TargetClass) => {
		Reflect.defineMetadata(PLUGIN_META_KEY, meta, constructorFunction)
	}
}

export function Config(configSchema: Object) {
	return (constructorFunction: TargetClass, propertyKey: string) => {
		const config =
			Reflect.getMetadata(PLUGIN_CONFIG_MAP, constructorFunction) ||
			Object.create(null)
		config[propertyKey] = configSchema
		Reflect.defineMetadata(PLUGIN_CONFIG_MAP, config, constructorFunction)
	}
}

/**
 * Optional 装饰器用于标记构造函数参数为可选依赖
 */
export function Optional(
	// biome-ignore lint/complexity/noBannedTypes: <explanation>
	target: Object,
	// biome-ignore lint/correctness/noUnusedVariables: <explanation>
	propertyKey: string | symbol | undefined,
	parameterIndex: number,
) {
	// 对于构造函数参数，target 为构造函数
	const existingOptionalParams: number[] =
		Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, target) || []
	existingOptionalParams.push(parameterIndex)
	Reflect.defineMetadata(OPTIONAL_PARAMS_KEY, existingOptionalParams, target)
}
