import type { Context } from '@pluxel/context'
import { getPluginInfo } from './PluginDecorator'

// HMR 注意：必须使用 Symbol.for
export const PLUGIN_CTX = Symbol.for('pluxel:plugin:ctx')
export const FORK_CTX = Symbol.for('pluxel:plugin:ctx:fork')

export abstract class BasePlugin<C extends Context = Context> {
	static [FORK_CTX]: () => Context
	public [PLUGIN_CTX]!: C

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

	public get caller() {
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
	init?(abort: AbortSignal): void | Promise<void>
	stop?(abort: AbortSignal): void | Promise<void>
}
