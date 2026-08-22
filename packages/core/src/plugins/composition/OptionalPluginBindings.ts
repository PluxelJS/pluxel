import type { Context } from '@pluxel/context'
import { requirePluginService } from '../../internal/plugin-service'
import type { Cleanup, DisposableLike } from '../../services/effects/EffectsService'
import { isPluginRef, type PluginRef } from '../runtime/definition'

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		!!value &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}

function isDisposable(value: unknown): value is DisposableLike {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { dispose?: unknown }).dispose === 'function'
	)
}

/** Init-only optional integration facade. Optional edges are static lowered facts. */
export class OptionalPluginBindings {
	constructor(
		private readonly ctx: Context,
		private readonly isInitActive: () => boolean,
	) {}

	use<T>(ref: PluginRef<T>, setup: (plugin: T) => void | Cleanup | DisposableLike): void {
		if (!this.isInitActive()) {
			throw new Error('[pluxel/core] plugins.use() is only available during Plugin init()')
		}
		if (!isPluginRef(ref)) {
			throw new TypeError('[pluxel/core] plugins.use() expects a lowered module-level PluginRef')
		}
		const registry = requirePluginService(this.ctx)
		const plugin = registry.resolvePluginRef(ref, this.ctx) as T | undefined
		if (plugin === undefined) return
		const resource = setup(plugin)
		if (isPromiseLike(resource)) {
			throw new TypeError('[pluxel/core] plugins.use() setup must be synchronous')
		}
		if (typeof resource === 'function') this.ctx.effects.defer(resource)
		else if (isDisposable(resource)) this.ctx.effects.own(resource)
		else if (resource !== undefined) {
			throw new TypeError('[pluxel/core] plugins.use() setup returned an invalid resource')
		}
	}
}
