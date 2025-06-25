// service-types.ts

/**
 * 从构造函数签名中提取 Context、实例、配置三要素
 */
export type ServiceContext<S> = S extends new (
	ctx: infer C,
	cfg: any,
) => any
	? C
	: never
export type ServiceInst<S> = S extends new (
	ctx: any,
	cfg: any,
) => infer I
	? I
	: never
export type ServiceCfg<S> = S extends new (
	ctx: any,
	cfg: infer C,
) => any
	? C
	: undefined

/**
 * 强约束：任意可注入 ctor 必须符合 new(ctx, cfg) => inst
 */
export type ServiceCtor<S extends new (ctx: any, cfg: any) => any> = S

/**
 * 给 ServiceCtor 增加可选的 metadata：key、methods
 */
export type ServiceClass<S extends new (ctx: any, cfg: any) => any> =
	ServiceCtor<S> & {
		/** 在 Context 上的访问名，默认由类名剥 “Service” 得到 */
		readonly key?: string
		/** 要在 Context 原型上代理的方法名列表 */
		readonly methods?: readonly Extract<keyof ServiceInst<S>, string>[]
	}
