// Service.ts

import { Context } from './Context'
import type {
	ServiceCfg,
	ServiceClass,
	ServiceContext,
	ServiceInst,
} from './service-types'

/**
 * 装饰器可选项
 */
export type ServiceOptions<S extends new (ctx: any, cfg: any) => any> = {
	key?: string
	methods?: readonly Extract<keyof ServiceInst<S>, string>[]
}

export const OVERRIDE_FLAG = Symbol('isOverride')
/**
 * 可注入装饰器 @Injectable 和 @Injectable({...})
 */
export function Injectable<S extends new (ctx: any, cfg: any) => any>(
	ctor: ServiceClass<S>,
): void
export function Injectable<S extends new (ctx: any, cfg: any) => any>(
	options: ServiceOptions<S>,
): (ctor: ServiceClass<S>) => void

export function Injectable<S extends new (...args: any) => any>(
	ctorOrOpts: any,
): any {
	// 直接用 @Injectable
	if (typeof ctorOrOpts === 'function') {
		const ctor = ctorOrOpts as ServiceClass<S>
		// 如果是 OverrideOf 标记的，就跳过“新注册”
		if ((ctor as any)[OVERRIDE_FLAG]) {
			return
		}
		Context.registerService(ctor)
		return
	}

	// 用 @Injectable({...})
	const opts = ctorOrOpts as ServiceOptions<any>
	return <T extends new (...args: any) => any>(ctor: ServiceClass<T>) => {
		if ((ctor as any)[OVERRIDE_FLAG]) {
			// override 的也跳过
		} else {
			if (opts.key) (ctor as any).key = opts.key
			if (opts.methods) (ctor as any).methods = opts.methods
			Context.registerService(ctor)
		}
	}
}

export function OverrideOf<S extends new (...args: any) => any>(
	original: ServiceClass<S>,
) {
	return <T extends new (...args: any) => any>(
		overrideCtor: ServiceClass<T>,
	) => {
		// 打个标记，让 Injectable 跳过 registerService
		;(overrideCtor as any)[OVERRIDE_FLAG] = true
		;(overrideCtor as any).key = (original as any).key
		Context.overrideService(original, overrideCtor)
	}
}
