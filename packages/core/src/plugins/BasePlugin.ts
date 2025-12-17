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
import { getPluginInfo } from './PluginDecorator'

// HMR 注意：必须使用 Symbol.for
export const PLUGIN_CTX = Symbol.for('pluxel:plugin:ctx')
export const FORK_CTX = Symbol.for('pluxel:plugin:ctx:fork')

export interface PluginLifecycleRuntime<C extends Context = Context> {
	beforeStart?: () => void
	init?: (signal: AbortSignal) => void | Promise<void>
	stop?: (signal: AbortSignal) => void | Promise<void>
	dispose?: () => void | Promise<void>
	subscribeErrors?: (cb: (err: unknown) => void) => void | (() => void)
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

	protected get caller() {
		return this.ctx.caller
	}

	static [Symbol.toPrimitive](_hint: string) {
		// Some abstract base classes are used only as DI keys and may not be
		// decorated with @Plugin. Avoid throwing during logging/stringification.
		let id: string
		try {
			// biome-ignore lint/complexity/noThisInStatic: <explanation>
			id = getPluginInfo(this)?.id ?? this.name
		} catch {
			// undecorated base
			id = this.name
		}
		// biome-ignore lint/complexity/noThisInStatic: <explanation>
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
					? (cb: (err: unknown) => void) => onError.call(ctx, cb)
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
