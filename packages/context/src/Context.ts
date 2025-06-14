// Context.ts
import type { InjectableService } from './Service'

type SymMap = { [k in symbol]?: symbol }

export class Context {
  /** 全局 serviceKey → instKey 映射 */
  private static defaultMapping: SymMap = Object.create(null)
  /** Service ctor → serviceKey 缓存，避免重复读取属性 */
  private static serviceKeyMap = new WeakMap<InjectableService<any, any, any>, symbol>()

  /** 本实例的映射（继承自 defaultMapping 或父 Context） */
  public mapping: SymMap
  /** 本实例或根 Context 的服务缓存 */
  private instances: Record<symbol, any> = Object.create(null)
  /** 父 Context（若有） */
  public parent?: Context
  /** 根 Context 指针 */
  public root: Context
  /** 可读名称 */
  public name: string
  /** 配置 */
  public config: Context.Config

  constructor(
    config: Context.Config = {},
    parent?: Context,
    name?: string
  ) {
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
   * 注册 Service
   * - 缓存 serviceKey
   * - 在原型上定义闭包 getter（捕获 ctor/sk/configKey）
   * - 在原型上代理 methods
   */
  static registerService<C extends Context, Inst extends object, Cfg>(
    ctor: InjectableService<C, Inst, Cfg>
  ) {
    // 1. 分配并缓存 serviceKey
    const sk = Symbol(ctor.name)
    Context.defaultMapping[sk] = sk
    Context.serviceKeyMap.set(ctor, sk)

    const configKey = (ctor as any).key as string | undefined
    const propName = configKey ?? ctor.name.replace(/Service$/, '')

    // 2. 定义闭包 getter，内联 sk 和 ctor
    if (!(propName in Context.prototype)) {
      Object.defineProperty(Context.prototype, propName, {
        configurable: true,
        get(this: Context) {
          return this._getService(ctor, sk, configKey)
        }
      })
    }

    // 3. 方法代理
    const methods: string[] = (ctor as any).methods ?? []
    for (const m of methods) {
      if (m in Context.prototype) continue
      Object.defineProperty(Context.prototype, m, {
        configurable: true,
        value(this: Context, ...args: any[]) {
          const inst = this._getService(ctor, sk, configKey) as any
          return inst[m](...args)
        }
      })
    }
  }

  /**
   * 私有：按 serviceKey 获取或创建实例
   * - inline 映射查找及实例化，不再从 ctor 读取 key
   */
  private _getService<Inst extends Object, Cfg>(
    ctor: InjectableService<any, Inst, Cfg>,
    sk: symbol,
    configKey?: string
  ): Inst {
    // 1. 读取或初始化 instKey
    let ik = this.mapping[sk]
    if (!ik) {
      ik = sk
      this.mapping[sk] = ik
    }

    // 2. 决定实例缓存位置：own mapping 则 this.instances，否则 root.instances
    const isIsolated = Object.prototype.hasOwnProperty.call(this.mapping, sk)
    const store = isIsolated ? this.instances : this.root.instances

    // 3. 获取或创建实例
    let inst = store[ik] as Inst
    if (!inst) {
      const cfg = configKey ? (this.config as any)[configKey] : undefined
      inst = new ctor(this as any, cfg)
      store[ik] = inst
    }
    return inst
  }

  /**
   * 扩展 Context：原型链克隆，映射克隆，实例共享
   */
  extend(opts: {
    name?: string
    config?: Partial<Context.Config>
  } = {}): this {
    const child = Object.create(this) as this
    child.parent = this
    child.root   = this.root
    child.name   = opts.name ?? `${this.name}.child`
    child.config = { ...this.config, ...(opts.config || {}) }
    child.mapping   = Object.create(this.mapping)
    child.instances = this.instances
    return child
  }

  /**
   * 隔离服务：指定服务写入子 Context 自己的 instances
   */
  isolate(
    ctors: InjectableService<any, any, any>[],
    opts: {
      name?: string
      config?: Partial<Context.Config>
    } = {}
  ): this {
    const child = this.extend(opts)
    // 克隆实例池，旧实例仍可被父/兄弟复用
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
