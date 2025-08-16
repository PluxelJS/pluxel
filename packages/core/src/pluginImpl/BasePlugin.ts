import type { Context } from '@pluxel/context'

// HMR 注意：必须使用 Symbol.for
export const PLUGIN_CTX = Symbol.for('pluxel:plugin:ctx')

export type Awaitable<T> = T | Promise<T>

export abstract class BasePlugin<C extends Context = Context> {
	public [PLUGIN_CTX]!: C

	/** Access system deps and register disposables */
	public get ctx(): C {
		if (!this[PLUGIN_CTX]) {
			throw new Error('Plugin context has not been set.')
		}
		return this[PLUGIN_CTX]
	}

	public get caller() {
		return this.ctx.caller
	}

	/** —— Optional lifecycles ——
	 * Plugins may implement either, both, or none.
	 * Use `override` when implementing to get compiler checks.
	 */
	init?(): Awaitable<void>
	stop?(): Awaitable<void>
}

/** —— Framework-side helpers (示例) —— */
export async function callInit(p: BasePlugin) {
	await p.init?.()
}
export async function callStop(p: BasePlugin) {
	await p.stop?.()
}
