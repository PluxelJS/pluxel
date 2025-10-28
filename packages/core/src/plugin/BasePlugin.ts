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
	protected get ctx(): C {
		return this[PLUGIN_CTX]
	}

	protected get caller() {
		return this.ctx.caller
	}

	static [Symbol.toPrimitive](_hint: string) {
		return `${
			// biome-ignore lint/complexity/noThisInStatic: <explanation>
			getPluginInfo(this)?.meta.name
		}(${
			// biome-ignore lint/complexity/noThisInStatic: <explanation>
			this.name
		})`
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
		const scope = (ctx as any)?.scope
		const emitWithContext = (ctx as any)?.emitWithContext
		const onError = (ctx as any)?.onError

		return {
			beforeStart:
				typeof emitWithContext === 'function'
					? () => emitWithContext.call(ctx, plugin, 'beforeStart', plugin)
					: undefined,
			init: typeof plugin.init === 'function' ? plugin.init.bind(plugin) : undefined,
			stop: typeof plugin.stop === 'function' ? plugin.stop.bind(plugin) : undefined,
			dispose:
				typeof scope?.disposeAll === 'function' ? scope.disposeAll.bind(scope) : undefined,
			subscribeErrors:
				typeof onError === 'function'
					? (cb: (err: unknown) => void) => onError.call(ctx, cb)
					: undefined,
		}
	}
}
