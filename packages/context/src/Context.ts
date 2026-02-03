// Context.ts

import type {
	ServiceCfg,
	ServiceClass,
	ServiceCtor,
	ServiceInst,
	ServiceOverrideCtor,
	ServiceWithCtx,
} from './service-types'

type SymMap = { [k in symbol]?: symbol }

// "Any service" should allow arbitrary instance types and method proxy lists.
// Using the default `ServiceClass<ServiceCtor>` would make `methods` resolve to `never[]`
// because `InstanceType<ServiceCtor>` is `unknown`.
// biome-ignore lint/suspicious/noExplicitAny: this is intentionally wide so WeakMap lookups accept any service ctor shape.
type AnyServiceClass = ServiceClass<new (ctx: Context, cfg?: any) => any>

type ServiceMeta = {
	sk: symbol
	key: string
	scope: 'context' | 'root'
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: this class is intentionally merged with an interface for service augmentation.
export class Context {
	/** 全局 serviceKey → instKey 映射 */
	private static defaultMapping: SymMap = Object.create(null)
	/** ServiceClass → meta 缓存 */
	private static serviceMetaByCtor = new WeakMap<AnyServiceClass, ServiceMeta>()
	/** service key (property name) → meta */
	private static serviceMetaByKey = new Map<string, ServiceMeta>()

	/** 本实例的映射（继承自 defaultMapping 或父 Context） */
	public mapping: SymMap
	/** 服务实例缓存，所有同 root 的 Context 共享，除 isolate 时另行克隆 */
	private instances: Record<symbol, unknown> = Object.create(null)
	public parent?: Context
	public root: Context.Root
	public name: string
	public config: Context.Config

	constructor(config: Context.Config = {}, parent?: Context, name?: string) {
		this.config = config
		this.parent = parent
		this.root = parent ? parent.root : (this as unknown as Context.Root)
		this.name = name ?? config.name ?? (parent ? parent.name : 'root')
		// mapping 继承全局或父级
		this.mapping = Object.create(Context.defaultMapping)
		// 如果有父，则共用同一个 instances 对象
		if (parent) this.instances = parent.instances
	}

	static registerService<S extends ServiceCtor>(ctor: ServiceClass<S>) {
		const sk = Symbol(ctor.name)
		const key = (ctor.key as string) ?? ctor.name.replace(/Service$/, '')
		if (Context.serviceMetaByKey.has(key)) {
			throw new Error('如果你要覆盖已有服务，先 override。')
		}
		if (key in Context.prototype) {
			throw new Error(
				`[pluxel/context] Invalid service key "${key}": conflicts with Context.prototype.`,
			)
		}
		const scope = ((ctor as unknown as { scope?: 'context' | 'root' }).scope ?? 'context') as
			| 'context'
			| 'root'
		const meta: ServiceMeta = { sk, key, scope }
		Context.serviceMetaByCtor.set(ctor as unknown as AnyServiceClass, meta)
		Context.serviceMetaByKey.set(key, meta)
		Context.defaultMapping[sk] = sk

		// 在原型上定义 getter：按 scope 在“注册阶段”分配不同实现，避免热路径分支。
		const getter: (this: Context) => ServiceInst<S> =
			meta.scope === 'root'
				? function (this: Context) {
						const root = this.root
						let inst = root.instances[sk] as ServiceInst<S>
						if (inst) {
							const withCtx = inst as unknown as ServiceWithCtx<Context>
							if (withCtx.ctx !== root) withCtx.ctx = root
							return inst
						}
						const cfg = (root.config as Record<string, unknown>)[key] as ServiceCfg<S>
						inst = new ctor(root, cfg) as ServiceInst<S>
						;(inst as unknown as ServiceWithCtx<Context>).ctx = root
						root.instances[sk] = inst
						return inst
					}
				: function (this: Context) {
						const ik = this.mapping[sk] as symbol

						// `ik === sk` means "use the shared root instance space".
						// Any override (`ik !== sk`) means we must use this context's instance store
						// so isolate() remains effective for the whole subtree (extend descendants).
						const store = ik === sk ? this.root.instances : this.instances

						let inst = store[ik] as ServiceInst<S>
						if (inst) {
							const withCtx = inst as unknown as ServiceWithCtx<Context>
							if (withCtx.ctx !== this) withCtx.ctx = this
							return inst
						}
						const cfg = (this.config as Record<string, unknown>)[key] as ServiceCfg<S>
						inst = new ctor(this, cfg) as ServiceInst<S>
						;(inst as unknown as ServiceWithCtx<Context>).ctx = this
						store[ik] = inst
						return inst
					}
		Object.defineProperty(Context.prototype, key, {
			configurable: true,
			get: getter,
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
	static overrideService<S extends ServiceCtor, T extends ServiceOverrideCtor<S>>(
		original: ServiceClass<S>,
		overrideCtor: ServiceClass<T>,
	) {
		// 1) 拿到同一个 sk
		const meta = Context.serviceMetaByCtor.get(original as unknown as AnyServiceClass)
		if (!meta) throw new Error('该服务从未被注册')
		// —— overrideCtor 指向同一个 meta ——
		Context.serviceMetaByCtor.set(overrideCtor as unknown as AnyServiceClass, meta)
		// 2) 确保新 ctor 有同样的 key（属性名）
		const key = meta.key
		;(overrideCtor as unknown as { key?: string }).key = (
			original as unknown as { key?: string }
		).key // 保险起见

		// 3) 重新在原型上 define，一次性把 overrideCtor capture 进闭包（按 scope 分配 getter 实现）
		const scope = ((overrideCtor as unknown as { scope?: 'context' | 'root' }).scope ??
			meta.scope) as 'context' | 'root'
		meta.scope = scope
		const sk = meta.sk
		const getter: (this: Context) => ServiceInst<S> =
			scope === 'root'
				? function (this: Context) {
						const root = this.root
						let inst = root.instances[sk] as ServiceInst<S>
						if (inst) {
							const withCtx = inst as unknown as ServiceWithCtx<Context>
							if (withCtx.ctx !== root) withCtx.ctx = root
							return inst
						}
						const cfg = (root.config as Record<string, unknown>)[key] as ServiceCfg<S>
						inst = new overrideCtor(root, cfg) as ServiceInst<S>
						;(inst as unknown as ServiceWithCtx<Context>).ctx = root
						root.instances[sk] = inst
						return inst
					}
				: function (this: Context) {
						const ik = this.mapping[sk] as symbol

						const store = ik === sk ? this.root.instances : this.instances

						let inst = store[ik] as ServiceInst<S>
						if (inst) {
							const withCtx = inst as unknown as ServiceWithCtx<Context>
							if (withCtx.ctx !== this) withCtx.ctx = this
							return inst
						}
						const cfg = (this.config as Record<string, unknown>)[key] as ServiceCfg<S>
						inst = new overrideCtor(this, cfg) as ServiceInst<S>
						;(inst as unknown as ServiceWithCtx<Context>).ctx = this
						store[ik] = inst
						return inst
					}
		Object.defineProperty(Context.prototype, key, {
			configurable: true,
			get: getter,
		})

		// 4) 同步补齐方法代理（不覆盖既有 Context 方法/代理）
		for (const m of overrideCtor.methods ?? []) {
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
		// `mapping` is an override map (only isolate writes). Reuse it for extend() to
		// avoid per-child objects and deep prototype chains.
		child.mapping = this.mapping
		child.instances = this.instances // 共享实例池

		return child
	}

	/**
	 * 隔离指定服务：克隆 instances 池，并为这些 ctor 单独生成 instKey
	 *
	 * Notes:
	 * - Root-scoped services cannot be isolated: they always resolve from `ctx.root`.
	 * - This API is intentionally ctor-based (stricter): passing the wrong ctor copy will throw.
	 *   This helps surface HMR/module-duplication issues instead of silently isolating "whatever is registered".
	 */
	isolate(ctors: Iterable<AnyServiceClass>, opts: Context.ExtendOpts = {}): this {
		const child = this.extend(opts)
		child.instances = Object.create(this.instances)
		child.mapping = Object.create(this.mapping)

		// 用 Set 去重，虽然重复也无害，但这样更直观
		for (const ctor of new Set(ctors)) {
			const meta = Context.serviceMetaByCtor.get(ctor)
			if (!meta) {
				const name = (ctor as unknown as { name?: string }).name
				throw new Error(
					`[pluxel/context] Cannot isolate an unregistered service: ${name || '<anonymous>'}`,
				)
			}
			if (meta.scope === 'root') {
				const key = meta.key
				throw new Error(
					`[pluxel/context] Cannot isolate a root-scoped service: ${key} (use ctx.root.${key}).`,
				)
			}
			child.mapping[meta.sk] = Symbol(ctor.name)
		}

		return child
	}

	/**
	 * Isolate by service keys (string names).
	 *
	 * This is more ergonomic and can be more type-friendly in config-driven code,
	 * but it is less strict than ctor-based isolation (it won't detect "wrong ctor copy").
	 */
	isolateKeys<K extends keyof Context.Services & string>(
		keys: Iterable<K>,
		opts: Context.ExtendOpts = {},
	): this {
		const child = this.extend(opts)
		child.instances = Object.create(this.instances)
		child.mapping = Object.create(this.mapping)

		for (const key of new Set(keys)) {
			const meta = Context.serviceMetaByKey.get(key)
			if (!meta) {
				throw new Error(`[pluxel/context] Cannot isolate an unregistered service key: ${key}`)
			}
			if (meta.scope === 'root') {
				throw new Error(
					`[pluxel/context] Cannot isolate a root-scoped service key: ${key} (use ctx.root.${key}).`,
				)
			}
			child.mapping[meta.sk] = Symbol(key)
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
	/**
	 * Service registry (type-level). Packages should augment this interface.
	 *
	 * `Context` instances will expose these services with `ctx` omitted from their public type.
	 */
	// biome-ignore lint/suspicious/noEmptyInterface: <>
	export interface Services {}
	// biome-ignore lint/suspicious/noEmptyInterface: <>
	export interface RootServices {}

	export type PublicService<T> = T extends { ctx: unknown } ? Omit<T, 'ctx'> : T
	export type PublicServices = { [K in keyof Services]: PublicService<Services[K]> }
	export type RootPublicServices = { [K in keyof RootServices]: PublicService<RootServices[K]> }
	export type Root = Context & RootPublicServices

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

	/**
	 * Options for {@link Context.extend}.
	 *
	 * Keep this type intentionally simple: `Context` instances are dynamic and
	 * type-level self-references can easily create circular aliases under `strict`.
	 */
	export type ExtendOpts = {
		name?: string
		config?: Context.Config
	} & Record<string | number | symbol, unknown>

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
