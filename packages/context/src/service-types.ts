// service-types.ts

/**
 * 从构造函数签名中提取 Context、实例、配置三要素
 */
import type { Context } from './Context'

type CtorParams<S> = S extends new (...args: infer P) => unknown ? P : never

export type ServiceContext<S> = CtorParams<S> extends [infer C, ...unknown[]] ? C : never
export type ServiceInst<S> = S extends new (...args: unknown[]) => infer I ? I : never
export type ServiceCfg<S> = CtorParams<S> extends [Context, infer C, ...unknown[]] ? C : undefined

/**
 * Services are expected to expose a writable `ctx` property so `Context` can
 * rebind the current execution context on every access.
 */
export type ServiceWithCtx<C> = { ctx: C }

/**
 * Service ctor signature:
 * - `cfg` is optional (many services don't need config).
 * - `ctx` is always the runtime `Context` instance (or a supertype of it).
 */
export type ServiceCtor<S extends new (ctx: Context, cfg?: unknown) => unknown> = S

/**
 * 给 ServiceCtor 增加可选的 metadata：key、methods
 */
export type ServiceClass<
	S extends new (
		ctx: Context,
		cfg?: unknown,
	) => unknown = new (
		ctx: Context,
		cfg?: unknown,
	) => unknown,
> = ServiceCtor<S> & {
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
