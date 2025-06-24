// Context.ts

import type { ServiceCfg, ServiceClass, ServiceInst } from './service-types'

type SymMap = { [k in symbol]?: symbol }

export class Context {
	/** 全局 serviceKey → instKey 映射 */
	private static defaultMapping: SymMap = Object.create(null)
	/** ServiceClass → serviceKey 缓存 */
	private static serviceKeyMap = new WeakMap<ServiceClass<any>, symbol>()

	/** 本实例的映射（继承自 defaultMapping 或父 Context） */
	public mapping: SymMap
	/** 服务实例缓存，所有同 root 的 Context 共享，除 isolate 时另行克隆 */
	private instances: Record<symbol, any> = Object.create(null)
	public parent?: Context
	public root: Context
	public name: string
	public config: Context.Config

	constructor(config: Context.Config = {}, parent?: Context, name?: string) {
		this.config = config
		this.parent = parent
		this.root = parent ? parent.root : this
		this.name = name ?? config.name ?? (parent ? parent.name : 'root')
		// mapping 继承全局或父级
		this.mapping = Object.create(Context.defaultMapping)
		// 如果有父，则共用同一个 instances 对象
		if (parent) this.instances = parent.instances
	}

	/**
	 * 注册 ServiceClass：生成 serviceKey，定义访问属性和方法代理
	 */
	static registerService<S extends new (ctx: any, cfg: any) => object>(
		ctor: ServiceClass<S>,
	) {
		// 1. 分配并缓存 serviceKey
		const sk = Symbol(ctor.name)
		Context.defaultMapping[sk] = sk
		Context.serviceKeyMap.set(ctor, sk)

		// 2. 访问属性名
		const configKey = (ctor.key as string) ?? ctor.name.replace(/Service$/, '')
		const propName = configKey

		// 3. 定义 getter
		if (!(propName in Context.prototype)) {
			Object.defineProperty(Context.prototype, propName, {
				configurable: true,
				get(this: Context) {
					return this._getService(ctor, sk)
				},
			})
		}

		// 4. 方法代理
		const methods = ctor.methods ?? []
		for (const m of methods) {
			if (m in Context.prototype) continue
			Object.defineProperty(Context.prototype, m, {
				configurable: true,
				value(this: Context, ...args: any[]) {
					const inst = this._getService(ctor, sk) as any
					return inst[m](...args)
				},
			})
		}
	}

	/**
	 * 私有：根据 serviceKey 获取或创建实例
	 */
	private _getService<S extends new (ctx: any, cfg: any) => object>(
		ctor: ServiceClass<S>,
		sk: symbol,
	): ServiceInst<S> {
		// instKey 从 mapping 读取或初始化
		let ik = this.mapping[sk]
		if (!ik) {
			ik = sk
			this.mapping[sk] = ik
		}

		// 决定缓存放 own or root
		const isolated = Object.prototype.hasOwnProperty.call(this.mapping, sk)
		const store = isolated ? this.instances : this.root.instances

		// 取或创建实例
		let inst = store[ik] as ServiceInst<S>
		if (!inst) {
			const cfg = (this.config as any)[
				((ctor as any).key as string) ?? ctor.name.replace(/Service$/, '')
			] as ServiceCfg<S>
			inst = new ctor(this as any, cfg) as ServiceInst<S>
			store[ik] = inst
		} else {
			// 每次访问都更新 ctx
			;(inst as any).ctx = this
		}
		return inst
	}

	/**
	 * 扩展 Context，继承 mapping & 共享 instances
	 */
	extend(opts: { name?: string; config?: Partial<Context.Config> } = {}): this {
		const child = Object.create(this) as this
		child.parent = this
		child.root = this.root
		child.name = opts.name ?? `${this.name}.child`
		child.config = { ...this.config, ...(opts.config || {}) }
		child.mapping = Object.create(this.mapping)
		child.instances = this.instances
		return child
	}

	/**
	 * 隔离指定服务：克隆 instances 池，并为这些 ctor 单独生成 instKey
	 */
	isolate(
		ctors: ServiceClass<any>[],
		opts: { name?: string; config?: Partial<Context.Config> } = {},
	): this {
		const child = this.extend(opts)
		child.instances = Object.create(this.instances)
		for (const ctor of ctors) {
			const sk = Context.serviceKeyMap.get(ctor)!
			child.mapping[sk] = Symbol(ctor.name)
		}
		return child
	}
}

export namespace Context {
	export interface Config {
		name?: string
		[key: string]: any
	}
}
