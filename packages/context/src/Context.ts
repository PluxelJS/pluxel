// Context.ts

import type {
	ServiceClass,
	ServiceContractInst,
	ServiceCtor,
	ServiceInst,
	ServiceOverrideCtor,
	ServiceWithCtx,
} from './service-types'

type SymMap = { [k in symbol]?: symbol }

// "Any service" should allow arbitrary instance types and method proxy lists.
// Using the default `ServiceClass<ServiceCtor>` would make `methods` resolve to `never[]`
// because `InstanceType<ServiceCtor>` is `unknown`.
type AnyServiceClass = ServiceClass<new (ctx: Context, cfg?: any) => any>

type ServiceMeta = {
	sk: symbol
	key: string
	scope: 'context' | 'root'
	eager: boolean
}
type RuntimeServiceCtor<T> = new (ctx: Context, cfg?: any) => T

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- this class is intentionally merged with an interface for service augmentation.
export class Context {
	get [Symbol.toStringTag]() {
		// Hint frameworks like Elysia that this is a class-like object, so they don't deep-merge
		// arbitrary runtime state into request contexts (which can accidentally traverse Vite config
		// objects and trigger deprecation setters like `optimizeDeps.rollupOptions`).
		return 'PluxelContext'
	}

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
	private servicePreparePromises = new Map<symbol, Promise<unknown>>()
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
		const eager = (ctor as unknown as { eager?: boolean }).eager === true
		const meta: ServiceMeta = { sk, key, scope, eager }
		Context.serviceMetaByCtor.set(ctor as unknown as AnyServiceClass, meta)
		Context.serviceMetaByKey.set(key, meta)
		Context.defaultMapping[sk] = sk

		Object.defineProperty(Context.prototype, key, {
			configurable: true,
			get: createServiceGetter<ServiceInst<S>>(
				ctor as unknown as RuntimeServiceCtor<ServiceInst<S>>,
				key,
				sk,
				meta.scope,
			),
		})

		installServiceProxies(key, ctor.methods, ctor.props)
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
		const eager = (overrideCtor as unknown as { eager?: boolean }).eager
		if (eager !== undefined) meta.eager = eager === true
		const sk = meta.sk
		Object.defineProperty(Context.prototype, key, {
			configurable: true,
			get: createServiceGetter<ServiceContractInst<S>>(
				overrideCtor as unknown as RuntimeServiceCtor<ServiceContractInst<S>>,
				key,
				sk,
				scope,
			),
		})

		// 4) 同步补齐代理（不覆盖既有 Context 方法/属性代理）
		installServiceProxies(key, overrideCtor.methods, overrideCtor.props)
	}

	async prepareServices(): Promise<void> {
		for (const meta of Context.serviceMetaByKey.values()) {
			if (!meta.eager) continue
			const target = meta.scope === 'root' ? this.root : this
			const service = (target as unknown as Record<string, unknown>)[meta.key]
			const prepare = (service as { prepare?: unknown } | null | undefined)?.prepare
			if (typeof prepare !== 'function') continue
			const existing = target.servicePreparePromises.get(meta.sk)
			if (existing) {
				await existing
				continue
			}
			const pending = Promise.resolve().then(() => prepare.call(service))
			target.servicePreparePromises.set(meta.sk, pending)
			try {
				await pending
			} finally {
				if (target.servicePreparePromises.get(meta.sk) === pending) {
					target.servicePreparePromises.delete(meta.sk)
				}
			}
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
		opts.config = { ...this.config, ...opts.config }

		// 3) 先把外部可覆写/新增的字段灌进去（相信外部用户，不做运行时判断）
		Object.assign(child, opts)

		child.parent = this
		child.root = this.root
		// `mapping` is an override map (only isolate writes). Reuse it for extend() to
		// avoid per-child objects and deep prototype chains.
		child.mapping = this.mapping
		child.instances = this.instances // 共享实例池
		child.servicePreparePromises = new Map()

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

function createServiceGetter<T>(
	ctor: RuntimeServiceCtor<T>,
	key: string,
	sk: symbol,
	scope: 'context' | 'root',
): (this: Context) => T {
	if (scope === 'root') {
		return function (this: Context) {
			const root = this.root
			let inst = root.instances[sk] as T
			if (inst) return bindServiceContext(inst, root)

			const cfg = (root.config as Record<string, unknown>)[key]
			inst = new ctor(root, cfg)
			bindServiceContext(inst, root)
			root.instances[sk] = inst
			return inst
		}
	}

	return function (this: Context) {
		const ik = this.mapping[sk] as symbol

		// Fast path: read from `this.instances` first.
		// - For non-isolated services, `ik === sk` and the instance lives in `root.instances`.
		//   `this.instances` either *is* `root.instances` (normal) or prototypically inherits it
		//   (after isolate() via Object.create), so lookups still hit.
		// - For isolated services, `ik !== sk` and the instance lives in `this.instances[ik]`.
		let inst = this.instances[ik] as T
		if (inst) return bindServiceContext(inst, this)

		const cfg = (this.config as Record<string, unknown>)[key]
		inst = new ctor(this, cfg)
		bindServiceContext(inst, this)
		// Only decide where to store on miss:
		// - `ik === sk` -> shared root space (avoid accidental isolation)
		// - `ik !== sk` -> this context's isolated space
		;(ik === sk ? this.root.instances : this.instances)[ik] = inst
		return inst
	}
}

function bindServiceContext<T>(inst: T, ctx: Context) {
	const withCtx = inst as unknown as ServiceWithCtx<Context>
	if (withCtx.ctx !== ctx) withCtx.ctx = ctx
	return inst
}

function installServiceProxies(
	key: string,
	methods?: readonly string[],
	props?: readonly string[],
) {
	for (const m of methods ?? []) {
		if (m in Context.prototype) continue
		Object.defineProperty(Context.prototype, m, {
			configurable: true,
			value(this: Context, ...args: unknown[]) {
				const svc = getServiceProxyTarget(this, key)
				const fn = svc[m] as unknown
				if (typeof fn !== 'function') {
					throw new TypeError(`[pluxel/context] Service method not found: ${key}.${m}`)
				}
				return (fn as (...a: unknown[]) => unknown).call(svc, ...args)
			},
		})
	}
	for (const p of props ?? []) {
		if (p in Context.prototype) continue
		Object.defineProperty(Context.prototype, p, {
			configurable: true,
			get(this: Context) {
				return getServiceProxyTarget(this, key)[p]
			},
		})
	}
}

function getServiceProxyTarget(ctx: Context, key: string) {
	return (ctx as unknown as Record<string, unknown>)[key] as Record<string, unknown>
}

const CONTEXT_IMPL = Symbol.for('pluxel:context:impl')
const CONTEXT_IMPL_META = Symbol.for('pluxel:context:impl:meta')
type ContextImplMeta = {
	url: string
	stack?: string
}
const contextGlobal = globalThis as unknown as Record<symbol, unknown>
const existingContextImpl = contextGlobal[CONTEXT_IMPL] as typeof Context | undefined
if (existingContextImpl && existingContextImpl !== Context) {
	const meta = contextGlobal[CONTEXT_IMPL_META] as ContextImplMeta | undefined
	throw new Error(
		[
			'[pluxel/context] Multiple Context implementations detected in the same runtime.',
			'This indicates that more than one copy of @pluxel/context was evaluated (e.g. via HMR runner/workspace resolution).',
			'Fix your module resolution to guarantee a single implementation.',
			`First implementation: ${meta?.url ?? '<unknown>'}`,
			`Current implementation: ${import.meta.url}`,
			meta?.stack ? `First implementation stack:\n${meta.stack}` : undefined,
		]
			.filter((line): line is string => typeof line === 'string')
			.join('\n'),
	)
}
if (!existingContextImpl) {
	Object.defineProperty(contextGlobal, CONTEXT_IMPL, {
		value: Context,
		configurable: false,
		enumerable: false,
		writable: false,
	})
	Object.defineProperty(contextGlobal, CONTEXT_IMPL_META, {
		value: {
			url: import.meta.url,
			stack: new Error('[pluxel/context] First Context implementation loaded here').stack,
		} satisfies ContextImplMeta,
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
	export interface Services {}
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
	 *       "hmr:*": true
	 *       "bundler": true
	 *     }
	 *   }
	 * }
	 * ```
	 */

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
		 * Values are `:`-separated topic strings. Supported patterns:
		 * - `hmr:batch` → enables that exact topic
		 * - `hmr:*` → enables the `hmr` topic prefix
		 * - `*` → enables all debug topics (discouraged)
		 *
		 * Notes:
		 * - Runtime launchers compile these once into the active root debug matcher.
		 * - Plugin debug records must also pass that plugin's dynamic log-level policy.
		 */
		debug?: readonly DebugTopicPattern[]
		[key: string]: unknown
	}
}

// Merge service surface into Context instances (types only).
export interface Context extends Context.PublicServices {}
