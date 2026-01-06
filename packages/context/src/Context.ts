// Context.ts

import type {
	ServiceCfg,
	ServiceClass,
	ServiceContext,
	ServiceInst,
	ServiceWithCtx,
} from './service-types'

type SymMap = { [k in symbol]?: symbol }

// biome-ignore lint/suspicious/noExplicitAny: type-level escape hatch for dynamic service registries.
type AnyServiceClass = ServiceClass<new (ctx: any, cfg: any) => unknown>

export class Context {
	/** 全局 serviceKey → instKey 映射 */
	private static defaultMapping: SymMap = Object.create(null)
	/** ServiceClass → serviceKey 缓存 */
	public static serviceKeyMap = new WeakMap<AnyServiceClass, symbol>()
	private static registeredKeys = new Set<string>()

	/** 本实例的映射（继承自 defaultMapping 或父 Context） */
	public mapping: SymMap
	/** 服务实例缓存，所有同 root 的 Context 共享，除 isolate 时另行克隆 */
	private instances: Record<symbol, unknown> = Object.create(null)
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

	// biome-ignore lint/suspicious/noExplicitAny: we intentionally use `any` in ctor constraints to preserve inference/variance.
	static registerService<S extends new (ctx: any, cfg: any) => object>(ctor: ServiceClass<S>) {
		const sk = Symbol(ctor.name)
		const key = (ctor.key as string) ?? ctor.name.replace(/Service$/, '')
		if (Context.registeredKeys.has(key)) {
			throw new Error('如果你要覆盖已有服务，先 override。')
		}
		Context.registeredKeys.add(key)
		Context.serviceKeyMap.set(ctor, sk)
		Context.defaultMapping[sk] = sk

		// 在原型上定义最简 getter，只 capture sk/ctor/key
		const scope = (ctor as unknown as { scope?: 'context' | 'root' }).scope
		Object.defineProperty(Context.prototype, key, {
			configurable: true,
			get(this: Context) {
				if (scope === 'root') {
					const root = this.root
					let ik = root.mapping[sk]
					if (ik === undefined) {
						root.mapping[sk] = ik = sk
					}

					let inst = root.instances[ik] as ServiceInst<S>
					if (inst) {
						;(inst as unknown as ServiceWithCtx<Context>).ctx = root
						return inst
					}
					const cfg = (root.config as Record<string, unknown>)[key] as ServiceCfg<S>
					inst = new ctor(root as ServiceContext<S>, cfg) as ServiceInst<S>
					;(inst as unknown as ServiceWithCtx<Context>).ctx = root
					root.instances[ik] = inst
					return inst
				}

				let ik = this.mapping[sk]
				if (ik === undefined) {
					this.mapping[sk] = ik = sk
				}

				const store = Object.hasOwn(this.mapping, sk) ? this.instances : this.root.instances

				let inst = store[ik] as ServiceInst<S>
				if (inst) {
					;(inst as unknown as ServiceWithCtx<Context>).ctx = this
					return inst
				}
				const cfg = (this.config as Record<string, unknown>)[key] as ServiceCfg<S>
				inst = new ctor(this as ServiceContext<S>, cfg) as ServiceInst<S>
				;(inst as unknown as ServiceWithCtx<Context>).ctx = this
				store[ik] = inst
				return inst
			},
		})

		// 方法代理（同样最轻）
		for (const m of ctor.methods ?? []) {
			if (m in Context.prototype) continue
			Object.defineProperty(Context.prototype, m, {
				configurable: true,
				value(this: Context, ...args: unknown[]) {
					const svc = (this as unknown as Record<string, unknown>)[key] as Record<string, unknown>
					const fn = svc[m] as unknown
					if (typeof fn !== 'function') {
						throw new Error(`[pluxel/context] Service method not found: ${key}.${m}`)
					}
					return (fn as (...a: unknown[]) => unknown).call(svc, ...args)
				},
			})
		}
	}

	/** 提供 override —— 同步把原来的 getter 整块替换掉 */
	static overrideService<
		S extends new (
			// biome-ignore lint/suspicious/noExplicitAny: we intentionally use `any` in ctor constraints to preserve inference/variance.
			ctx: any,
			// biome-ignore lint/suspicious/noExplicitAny: we intentionally use `any` in ctor constraints to preserve inference/variance.
			cfg: any,
		) => unknown,
		T extends new (
			ctx: ServiceContext<S>,
			cfg: ServiceCfg<S>,
		) => ServiceInst<S>,
	>(original: ServiceClass<S>, overrideCtor: ServiceClass<T>) {
		// 1) 拿到同一个 sk
		const sk = Context.serviceKeyMap.get(original)
		if (sk === undefined) throw new Error('该服务从未被注册')
		// —— 新增：把 overrideCtor 也注册到同一个 sk ——
		Context.serviceKeyMap.set(overrideCtor, sk)
		// 2) 确保新 ctor 有同样的 key（属性名）
		const key = (original.key as string) ?? original.name.replace(/Service$/, '')
		;(overrideCtor as unknown as { key?: string }).key = (
			original as unknown as { key?: string }
		).key // 保险起见

		// 3) 重新在原型上 define，一次性把 overrideCtor capture 进闭包
		const scope = (overrideCtor as unknown as { scope?: 'context' | 'root' }).scope
		Object.defineProperty(Context.prototype, key, {
			configurable: true,
			get(this: Context) {
				if (scope === 'root') {
					const root = this.root
					let ik = root.mapping[sk]
					if (ik === undefined) {
						root.mapping[sk] = ik = sk
					}

					let inst = root.instances[ik] as ServiceInst<S>
					if (inst) {
						;(inst as unknown as ServiceWithCtx<Context>).ctx = root
						return inst
					}
					const cfg = (root.config as Record<string, unknown>)[key] as ServiceCfg<S>
					inst = new overrideCtor(root as ServiceContext<S>, cfg) as ServiceInst<S>
					;(inst as unknown as ServiceWithCtx<Context>).ctx = root
					root.instances[ik] = inst
					return inst
				}

				let ik = this.mapping[sk]
				if (ik === undefined) {
					this.mapping[sk] = ik = sk
				}

				const store = Object.hasOwn(this.mapping, sk) ? this.instances : this.root.instances

				let inst = store[ik] as ServiceInst<S>
				if (inst) {
					;(inst as unknown as ServiceWithCtx<Context>).ctx = this
					return inst
				}
				const cfg = (this.config as Record<string, unknown>)[key] as ServiceCfg<S>
				inst = new overrideCtor(this as ServiceContext<S>, cfg) as ServiceInst<S>
				;(inst as unknown as ServiceWithCtx<Context>).ctx = this
				store[ik] = inst
				return inst
			},
		})

		// 4) 同步更新方法代理
		for (const m of overrideCtor.methods ?? []) {
			Object.defineProperty(Context.prototype, m, {
				configurable: true,
				value(this: Context, ...args: unknown[]) {
					const svc = (this as unknown as Record<string, unknown>)[key] as Record<string, unknown>
					const fn = svc[m] as unknown
					if (typeof fn !== 'function') {
						throw new Error(`[pluxel/context] Service method not found: ${key}.${m}`)
					}
					return (fn as (...a: unknown[]) => unknown).call(svc, ...args)
				},
			})
		}
	}
	/**
	 * 扩展 Context，继承 mapping & 共享 instances
	 */
	extend(opts: Context.ExtendOpts = {}): this {
		// 1) 先基于当前实例做原型继承，保证外部挂在 prototype 上的扩展天然可见
		const child = Object.create(this) as this

		// 2) 规范化 name/config（config 合并、name 默认）
		opts.name = opts.name ?? `${this.name}.child`
		opts.config = { ...this.config, ...(opts.config ?? {}) }

		// 3) 先把外部可覆写/新增的字段灌进去（相信外部用户，不做运行时判断）
		Object.assign(child, opts)

		child.parent = this
		child.root = this.root
		child.mapping = Object.create(this.mapping) // 影子映射
		child.instances = this.instances // 共享实例池

		return child
	}

	/**
	 * 隔离指定服务：克隆 instances 池，并为这些 ctor 单独生成 instKey
	 * @param ctors 可迭代的 ServiceClass 集合，重复项会被自动忽略
	 */
	isolate(ctors: Iterable<AnyServiceClass>, opts: Context.ExtendOpts = {}): this {
		const child = this.extend(opts)
		child.instances = Object.create(this.instances)

		// 用 Set 去重，虽然重复也无害，但这样更直观
		for (const ctor of new Set(ctors)) {
			const sk = Context.serviceKeyMap.get(ctor)!
			child.mapping[sk] = Symbol(ctor.name)
		}

		return child
	}
}

const CONTEXT_IMPL = Symbol.for('pluxel:context:impl')
const existingContextImpl = (globalThis as unknown as Record<symbol, unknown>)[CONTEXT_IMPL] as
	| typeof Context
	| undefined
if (existingContextImpl && existingContextImpl !== Context) {
	throw new Error(
		[
			'[pluxel/context] Multiple Context implementations detected in the same runtime.',
			'This indicates that more than one copy of @pluxel/context was evaluated (e.g. via HMR runner/workspace resolution).',
			'Fix your module resolution to guarantee a single implementation.',
		].join('\n'),
	)
}
if (!existingContextImpl) {
	Object.defineProperty(globalThis, CONTEXT_IMPL, {
		value: Context,
		configurable: false,
		enumerable: false,
		writable: false,
	})
}

export namespace Context {
	type Fn = (...args: unknown[]) => unknown
	type MethodKeys<T> = {
		[K in keyof T]-?: T[K] extends Fn ? K : never
	}[keyof T]

	/**
	 * Service registry (type-level). Packages should augment this interface.
	 *
	 * `Context` instances will expose these services with `ctx` omitted from their public type.
	 */
	// biome-ignore lint/suspicious/noEmptyInterface: <>
	export interface Services {}

	export type PublicService<T> = T extends { ctx: unknown } ? Omit<T, 'ctx'> : T
	export type PublicServices = { [K in keyof Services]: PublicService<Services[K]> }

	type LiteralUnion<T extends U, U = string> = T | (U & Record<never, never>)

	/**
	 * Debug topic registry (type-level).
	 *
	 * Packages/apps can augment this interface to provide IntelliSense for
	 * `Context.Config.debug` entries without restricting arbitrary strings.
	 *
	 * @example
	 * ```ts
	 * declare module "@pluxel/context" {
	 *   namespace Context {
	 *     interface DebugTopics {
	 *       "pluxel:hmr:*": true
	 *       "pluxel:bundler": true
	 *     }
	 *   }
	 * }
	 * ```
	 */

	// biome-ignore lint/suspicious/noEmptyInterface: <>
	export interface DebugTopics {}

	type DebugTopicKey = keyof DebugTopics & string
	type DebugTopicKeyNoWildcard = Exclude<DebugTopicKey, `${string}*${string}`>
	type DebugTopicPatternLiteral = DebugTopicKey | `${DebugTopicKeyNoWildcard}:*` | '*'

	export type DebugTopicPattern = LiteralUnion<DebugTopicPatternLiteral, string>

	// 这些键不允许通过 extend 覆写（内部或结构键）
	type InternalKeys = 'parent' | 'root' | 'mapping' | 'instances' | 'constructor'

	// 允许覆写/新增的一切（包含外部 declare 的扩展字段）
	export type ExtendOpts = Partial<Omit<Context, InternalKeys | MethodKeys<Context>>> &
		// 允许用户自定义新键（不在 Context 类型里也可）
		Record<string | number | symbol, unknown>

	export interface Config {
		name?: string
		/**
		 * Enable debug topics (pluxel convention).
		 *
		 * Values are `:`-separated category strings. Supported patterns:
		 * - `pluxel:hmr:batch` → enables that exact category
		 * - `pluxel:hmr:*` → enables the prefix category `["pluxel","hmr"]` (and thus its children)
		 * - `*` → enables all debug topics (discouraged)
		 *
		 * Notes:
		 * - Used by `@pluxel/hmr` to gate internal debug logs and to seed LogTape auto-config debug rules.
		 * - Consumers can also pass these to `createPluxelLogtapeConfig({ debug })`.
		 */
		debug?: readonly DebugTopicPattern[]
		[key: string]: unknown
	}
}

// Merge service surface into Context instances (types only).
export interface Context extends Context.PublicServices {}
