// Context.ts
import type { InjectableService } from './Service'

type SymMap = { [k in symbol]?: symbol }

export class Context {
	/** 全局：每个 ctor._serviceKey → 实例键，和所有服务的 defaultConfig */
	private static defaultMapping: SymMap = Object.create(null)
	/** 实例层面：克隆的映射、合并后的配置，以及服务实例仓库 */
	public mapping: SymMap
	private instances: Record<symbol, any> = Object.create(null)

	constructor(public config: Context.Config = {}) {
		// 复制一份全局 serviceKey→instKey 映射
		this.mapping = Object.create(Context.defaultMapping)
	}

	/**
	 * 注册 Service 到 Context
	 * - ctor.key       → 决定注入到 ctx[key]
	 * - ctor.defaultConfig & ctor.key → 合并到 defaultConfigs，用于构造时注入
	 * - ctor.methods   → 决定挂到 ctx.prototype 的快捷方法
	 */
	static registerService<C extends Context, Inst extends object, Cfg>(
		ctor: InjectableService<C, Inst, Cfg>,
	) {
		// ——— 分配唯一 symbol 作为 serviceKey
		const serviceKey = Symbol(ctor.name)
		Context.defaultMapping[serviceKey] = serviceKey
		;(ctor as any)._serviceKey = serviceKey

		// ——— 挂实例属性：ctx[instanceProp] => Service 实例
		const instanceProp = (ctor as any).key ?? ctor.name.replace(/Service$/, '')
		console.log(instanceProp)
		if (!(instanceProp in Context.prototype)) {
			Object.defineProperty(Context.prototype, instanceProp, {
				configurable: true,
				get(this: Context) {
					return this.getService(ctor as any)
				},
			})
		}

		if (ctor.methods === undefined) return
		// ——— 挂方法代理：ctx[method](...) => inst[method](...)
		for (const method of ctor.methods) {
			if (method in Context.prototype) continue
			Object.defineProperty(Context.prototype, method, {
				configurable: true,
				value(this: Context, ...args: any[]) {
					const inst = this.getService(ctor as any) as any
					return inst[method](...args)
				},
			})
		}
	}

	/**
	 * 延迟创建 & 缓存 Service 实例
	 * - 取 ctor._serviceKey 得到 serviceKey
	 * - 通过 mapping[serviceKey] 拿 instKey
	 * - new ctor(this, cfg) 并存入 instances
	 */
	private getService<C extends Context, Inst extends object, Cfg>(
		ctor: InjectableService<C, Inst, Cfg>,
	): Inst {
		const sk = (ctor as any)._serviceKey as symbol
		const ik = this.mapping[sk]!
		// 先从 this.instances（own + 原型链）里查
		let inst: Inst = this.instances[ik]
		if (!inst) {
			// 构造新实例
			const cfg = ctor.key ? (this.config as any)[ctor.key] : undefined
			inst = new ctor(this as any, cfg)

			// ——判断是否被 isolate() 隔离了？——
			const isIsolated = Object.prototype.hasOwnProperty.call(this.mapping, sk)

			if (isIsolated) {
				// 被隔离：只存当前上下文
				this.instances[ik] = inst
			} else {
				// 未隔离：存到最顶层的 instances，让 root/child 都能复用
				let container: Record<symbol, any> = this.instances
				// 沿着实例 obj 的原型链，一直往上，直到最顶层（proto 为 null）
				while (Object.getPrototypeOf(container)) {
					container = Object.getPrototypeOf(container) as any
				}
				container[ik] = inst
			}
		}
		return inst
	}

	extend(meta = {}): this {
		return Object.assign(Object.create(this), meta)
	}
	/**
	 * 隔离：为指定 Services 生成新 instKey，子 ctx 对它们有独立实例
	 */
	isolate(ctors: InjectableService<any, any, any>[]): this {
		const child = Object.create(this) as this

		// 继承父级的 serviceKey → instKey 映射
		child.mapping = Object.create(this.mapping)
		// 继承父级已创建的实例
		child.instances = Object.create(this.instances)

		for (const ctor of ctors) {
			const sk = (ctor as any)._serviceKey as symbol
			const fresh = Symbol(ctor.name)
			child.mapping[sk] = fresh
			// 不需要手动删除 child.instances[fresh]，new ctor 时自然缓存
		}

		return child
	}
}

export namespace Context {
	/** 所有服务共享的配置接口 */
	// biome-ignore lint/suspicious/noEmptyInterface: <explanation>
	export interface Config {}
}
