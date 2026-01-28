// service-types.ts

/**
 * 从构造函数签名中提取 Context、实例、配置三要素
 */
import type { Context } from './Context'

type AnyCtor = abstract new (...args: any[]) => any

export type ServiceContext<S extends AnyCtor> =
	ConstructorParameters<S> extends [infer C, ...any[]] ? C : never
export type ServiceInst<S extends AnyCtor> = InstanceType<S>
export type ServiceCfg<S extends AnyCtor> =
	ConstructorParameters<S> extends [Context, infer C, ...any[]] ? C : undefined

/**
 * Services are expected to expose a writable `ctx` property so `Context` can
 * rebind the current execution context on every access.
 */
export type ServiceWithCtx<C> = { ctx: C }

/**
 * Service ctor signature:
 * - `cfg` is always passed by `Context` (can be `undefined`).
 * - `ctx` is always the runtime `Context` instance (or a supertype of it).
 */
export type ServiceCtor = new (ctx: Context, cfg: any) => unknown

/**
 * 给 Service ctor 增加可选的 metadata：key、methods
 */
export type ServiceClass<
	S extends ServiceCtor = ServiceCtor,
> = S & {
	/** 在 Context 上的访问名，默认由类名剥 “Service” 得到 */
	readonly key?: string
	/** 要在 Context 原型上代理的方法名列表 */
	readonly methods?: readonly Extract<keyof ServiceInst<S>, string>[]
	/**
	 * Service scope:
	 * - `"context"` (default): service is shared but `ctx` is rebound on every access
	 * - `"root"`: service is rooted at `ctx.root` and never sees child ctx
	 */
	readonly scope?: 'context' | 'root'
}
