// PluginDecorator.ts
import "reflect-metadata";

export const PLUGIN_META_KEY = Symbol("plugin:meta");

// 新增：Optional 装饰器 key
export const OPTIONAL_PARAMS_KEY = Symbol("optional:params");

export interface PluginMetadata {
  name: string;
  type: "event" | "hook" | string;
  // 其他元数据可按需扩展
}

export function Plugin(meta: PluginMetadata) {
  return function (constructor: Function) {
    Reflect.defineMetadata(PLUGIN_META_KEY, meta, constructor);
  };
}

/**
 * Optional 装饰器用于标记构造函数参数为可选依赖
 */
export function Optional(
  target: Object,
  propertyKey: string | symbol | undefined,
  parameterIndex: number
) {
  // 对于构造函数参数，target 为构造函数
  const existingOptionalParams: number[] =
    Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, target) || [];
  existingOptionalParams.push(parameterIndex);
  Reflect.defineMetadata(OPTIONAL_PARAMS_KEY, existingOptionalParams, target);
}
