// types.ts
// Shared plugin type aliases. Kept tiny for minimal type‑level coupling.

import type { BasePlugin } from './composition/BasePlugin'

export type AnyFn = (...args: any[]) => any
export type Newable<T> = new (...args: any[]) => T
export type Abstract<T> = abstract new (...args: any[]) => T
export type Identifier<T> = Newable<T> | Abstract<T>

export type SubclassOf<B extends Identifier<any>> = abstract new (...args: any[]) => InstanceType<B>

// ✅ 插件特有别名
export type PluginConstructor = Newable<BasePlugin>
export type PluginToken = Identifier<BasePlugin>
