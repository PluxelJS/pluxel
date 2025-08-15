export type { Newable, Abstract, Identifier } from '../container'

import type { Identifier, Newable } from '../container'
import type { BasePlugin } from './BasePlugin'

export type AnyFn = (...args: any[]) => any

export type SubclassOf<B extends Identifier<any>> = abstract new (
	...args: any[]
) => InstanceType<B>

// ✅ 插件特有别名
export type PluginConstructor = Newable<BasePlugin>
export type PluginIdentifier = Identifier<BasePlugin>
export type PluginInstance = BasePlugin

export * from 'option-t/plain_result'
