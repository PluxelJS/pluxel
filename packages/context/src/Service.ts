// Service.ts
import { Context } from './Context'

/** 原先的可注入 Service 签名 */
export interface InjectableService<
	C extends Context,
	Inst extends object,
	Cfg = undefined,
> {
	readonly key?: string
	readonly methods?: readonly (keyof Inst)[]
	new (ctx: C, config: Cfg): Inst
}

/** 给 ClassDecoratorFactory 定义一个泛型类型 */
export type ServiceOptions<T extends new (...args: any[]) => any> = {
	/** 实例方法代理名 */
	key?: string
	/** 只能填 Inst 上真实存在的方法名 */
	methods?: Extract<keyof InstanceType<T>, string>[]
}

/** 重载签名：
 * 1) 直接 `@Injectable`
 * 2) `@Injectable({...})`
 */
export function Injectable<
	C extends Context,
	Inst extends object,
	Cfg = undefined,
>(ctor: InjectableService<C, Inst, Cfg>): void
export function Injectable<T extends new (...args: any[]) => any>(
	options: ServiceOptions<T>,
): (ctor: T) => void

export function Injectable(arg: any): any {
	// —— 无参装饰器 @Injectable
	if (typeof arg === 'function') {
		Context.registerService(arg)
		return
	}
	// —— 有参装饰器 @Injectable({...})
	const opts = arg as ServiceOptions<any>
	return <T extends new (...args: any[]) => any>(ctor: T) => {
		if (opts.key) (ctor as any).key = opts.key
		if (opts.methods) (ctor as any).methods = opts.methods
		Context.registerService(ctor)
	}
}
