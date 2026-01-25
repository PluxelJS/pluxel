// BasePlugin.ts
// Core runtime base class for all plugins.
//
// Responsibilities:
// - Provide `ctx` (DI context) to instances via FORK_CTX injection.
// - Offer optional lifecycle hooks (`init`, `stop`).
// - Expose `getLifecycleRuntime` adapter used by the lifecycle actor.
//
// This file sits on the construction hot‑path; keep it allocation‑light.

import type { Context } from '@pluxel/context'
import type { AnyCtor } from '../decorators/decorator/shared'
import { getPluginInfo } from '../decorators/PluginDecorator'
import { ConfigHost } from './ConfigHost'
import { FeatureHost } from './FeatureHost'

// HMR 注意：必须使用 Symbol.for
export const PLUGIN_CTX = Symbol.for('pluxel:plugin:ctx')
export const FORK_CTX = Symbol.for('pluxel:plugin:ctx:fork')
const FEATURE_HOST = Symbol.for('pluxel:plugin:featureHost')
const CONFIG_HOST = Symbol.for('pluxel:plugin:configHost')

export interface PluginLifecycleRuntime<_C extends Context = Context> {
	beforeStart?: () => void
	init?: (signal: AbortSignal) => void | Promise<void>
	stop?: (signal: AbortSignal) => void | Promise<void>
	dispose?: () => void | Promise<void>
	subscribeErrors?: (cb: (err: unknown) => void) => undefined | (() => void)
}

export type PluginContextOf<P extends BasePlugin> = P extends BasePlugin<infer C> ? C : Context

export abstract class BasePlugin<C extends Context = Context> {
	static [FORK_CTX]: () => Context
	protected [PLUGIN_CTX]!: C

	constructor() {
		if (BasePlugin[FORK_CTX] === undefined) {
			throw new Error("Don't instantiate BasePlugin directly.")
		}
		this[PLUGIN_CTX] = BasePlugin[FORK_CTX]() as C
	}

	/** Access system deps and register disposables */
	public get ctx(): C {
		return this[PLUGIN_CTX]
	}

	/** Feature composition (plan A): one scoped host per effective ctx. */
	public get features(): FeatureHost<BasePlugin<C>> {
		const self = this as unknown as { [FEATURE_HOST]?: FeatureHost<BasePlugin<C>> }
		const existing = self[FEATURE_HOST]
		if (existing && existing.ctx === (this.ctx as unknown as Context)) return existing

		const ctor = (this as unknown as { constructor?: unknown }).constructor
		const ownerCtor = typeof ctor === 'function' ? (ctor as unknown as AnyCtor) : undefined
		const host = new FeatureHost<BasePlugin<C>>(this.ctx as unknown as Context, ownerCtor, this)
		Object.defineProperty(this, FEATURE_HOST, {
			value: host,
			writable: false,
			enumerable: false,
			configurable: false,
		})
		return host
	}

	/** Config declaration helper: `foo = this.configs.use(schema)` */
	public get configs(): ConfigHost {
		const self = this as unknown as { [CONFIG_HOST]?: ConfigHost }
		const existing = self[CONFIG_HOST]
		if (existing && existing.ctx === (this.ctx as unknown as Context)) return existing

		const host = new ConfigHost(this.ctx as unknown as Context)
		Object.defineProperty(this, CONFIG_HOST, {
			value: host,
			writable: false,
			enumerable: false,
			configurable: false,
		})
		return host
	}

	protected get caller() {
		return this.ctx.caller
	}

	static [Symbol.toPrimitive](_hint: string) {
		// Some abstract base classes are used only as DI keys and may not be
		// decorated with @Plugin. Avoid throwing during logging/stringification.
		let id: string
		try {
			// biome-ignore lint/complexity/noThisInStatic: safe for Symbol.toPrimitive formatting
			id = getPluginInfo(this)?.id ?? this.name
		} catch {
			// undecorated base
			id = BasePlugin.name
		}
		// biome-ignore lint/complexity/noThisInStatic: safe for Symbol.toPrimitive formatting
		return `${id}(${this.name})`
	}

	/** —— Optional lifecycles ——
	 * Plugins may implement either, both, or none.
	 * Use `override` when implementing to get compiler checks.
	 */
	protected init?(abort: AbortSignal): void | Promise<void>
	protected stop?(abort: AbortSignal): void | Promise<void>

	static getLifecycleRuntime<P extends BasePlugin>(
		plugin: P,
	): PluginLifecycleRuntime<PluginContextOf<P>> {
		const ctx = plugin[PLUGIN_CTX] as PluginContextOf<P>
		const extended = ctx as unknown as {
			scope?: { disposeAll?: () => void | Promise<void> }
			emitWithContext?: (thisArg: unknown, event: string, ...args: unknown[]) => unknown
			onError?: (cb: (err: unknown) => void) => unknown
		}
		const scope = extended.scope
		const emitWithContext = extended.emitWithContext
		const onError = extended.onError

		return {
			beforeStart:
				typeof emitWithContext === 'function'
					? () => emitWithContext.call(ctx, plugin, 'beforeStart', plugin)
					: undefined,
			init: typeof plugin.init === 'function' ? plugin.init.bind(plugin) : undefined,
			stop: typeof plugin.stop === 'function' ? plugin.stop.bind(plugin) : undefined,
			dispose: typeof scope?.disposeAll === 'function' ? scope.disposeAll.bind(scope) : undefined,
			subscribeErrors:
				typeof onError === 'function'
					? (cb: (err: unknown) => void) => {
							const off = onError.call(ctx, cb)
							return typeof off === 'function' ? (off as () => void) : undefined
						}
					: undefined,
		}
	}
}

/**
 * ForkablePlugin
 *
 * Only plugins that extend this class are allowed to be forked into multiple
 * runtime instances (multiple ForkCtors).
 *
 * This is a strict opt‑in to keep the system deterministic and fast:
 * - no runtime decorators/flags;
 * - no fallback paths.
 */
export abstract class ForkablePlugin<C extends Context = Context> extends BasePlugin<C> {}
