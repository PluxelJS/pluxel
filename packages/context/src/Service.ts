// Service.ts

import { Context } from './Context'
import type {
	ServiceCfg,
	ServiceClass,
	ServiceContext,
	ServiceInst,
	ServiceWithCtx,
} from './service-types'

type InjectableCtor = new (ctx: Context, cfg: unknown) => ServiceWithCtx<Context>

/**
 * 装饰器可选项
 */
export type ServiceOptions<S extends InjectableCtor> = {
	key?: string
	methods?: readonly Extract<keyof ServiceInst<S>, string>[]
	scope?: 'context' | 'root'
}

type AnyServiceOptions = {
	key?: string
	methods?: readonly string[]
	scope?: 'context' | 'root'
}

type MutableServiceMeta = {
	[OVERRIDE_FLAG]?: true
	key?: string
	methods?: readonly string[]
	scope?: 'context' | 'root'
}

export const OVERRIDE_FLAG = Symbol('isOverride')
/**
 * 可注入装饰器 @Injectable 和 @Injectable({...})
 */
export function Injectable<S extends InjectableCtor>(ctor: ServiceClass<S>): void
export function Injectable<S extends InjectableCtor>(
	options: ServiceOptions<S>,
): (ctor: ServiceClass<S>) => void

export function Injectable<S extends new (...args: unknown[]) => object>(
	ctorOrOpts: unknown,
): unknown {
	// 直接用 @Injectable
	if (typeof ctorOrOpts === 'function') {
		const ctor = ctorOrOpts as ServiceClass<S>
		// 如果是 OverrideOf 标记的，就跳过“新注册”
		if ((ctor as unknown as MutableServiceMeta)[OVERRIDE_FLAG]) {
			return undefined
		}
		Context.registerService(ctor)
		return undefined
	}

	// 用 @Injectable({...})
	const opts = ctorOrOpts as AnyServiceOptions
	return <T extends InjectableCtor>(ctor: ServiceClass<T>) => {
		const meta = ctor as unknown as MutableServiceMeta
		if (meta[OVERRIDE_FLAG]) {
			// override 的也跳过
		} else {
			if (opts.key) meta.key = opts.key
			if (opts.methods) meta.methods = opts.methods
			if (opts.scope) meta.scope = opts.scope
			Context.registerService(ctor)
		}
	}
}

export function OverrideOf<S extends InjectableCtor>(original: ServiceClass<S>) {
	return <T extends new (ctx: ServiceContext<S>, cfg: ServiceCfg<S>) => ServiceInst<S>>(
		overrideCtor: ServiceClass<T>,
	) => {
		// 打个标记，让 Injectable 跳过 registerService
		const overrideMeta = overrideCtor as unknown as MutableServiceMeta
		const originalMeta = original as unknown as MutableServiceMeta
		overrideMeta[OVERRIDE_FLAG] = true
		overrideMeta.key = originalMeta.key
		if (overrideMeta.scope === undefined) {
			overrideMeta.scope = originalMeta.scope
		}
		Context.overrideService(original, overrideCtor)
	}
}
