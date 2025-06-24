// Service.ts

import { Context } from './Context'
import type { ServiceClass, ServiceOptions } from './service-types'

/**
 * 可注入装饰器 @Injectable 和 @Injectable({...})
 */
export function Injectable<S extends new (ctx: any, cfg: any) => any>(
	ctor: ServiceClass<S>,
): void
export function Injectable<S extends new (ctx: any, cfg: any) => any>(
	options: ServiceOptions<S>,
): (ctor: ServiceClass<S>) => void

export function Injectable(arg: any): any {
	if (typeof arg === 'function') {
		// @Injectable
		Context.registerService(arg)
		return
	}
	// @Injectable({ key, methods })
	const opts = arg as ServiceOptions<any>
	return <T extends new (...args: any[]) => any>(ctor: ServiceClass<T>) => {
		if (opts.key) (ctor as any).key = opts.key
		if (opts.methods) (ctor as any).methods = opts.methods
		Context.registerService(ctor)
	}
}
