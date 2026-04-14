// types.ts
// Shared plugin type aliases. Kept tiny for minimal type‑level coupling.

import type { BasePlugin, ForkablePlugin } from './composition/BasePlugin'

export type AnyFn = (...args: any[]) => any
export type Newable<T> = new (...args: any[]) => T
export type Abstract<T> = abstract new (...args: any[]) => T
export type Identifier<T> = Newable<T> | Abstract<T>

export type SubclassOf<B extends Identifier<any>> = abstract new (...args: any[]) => InstanceType<B>

// ✅ 插件特有别名
export type PluginConstructor = Newable<BasePlugin>
export type PluginIdentifier = Identifier<BasePlugin>
export type PluginInstance = BasePlugin & { [config: string | symbol]: any }

// Forkable plugins are the only ones allowed to produce forks.
export type ForkablePluginConstructor = Newable<ForkablePlugin>
