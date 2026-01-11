import type { Context } from '@pluxel/context'
import type { BasePlugin } from './BasePlugin'
import { PLUGIN_CTX } from './BasePlugin'

/**
 * Create a "caller-injected" view of a dependency plugin instance.
 *
 * This mirrors the constructor-injection behavior in PluginDefinitions:
 * the returned object delegates to `dep` but overrides `ctx` so that
 * `dep.ctx.caller === callerCtx`.
 *
 * This is useful for cross-plugin decorators that need to access dependency
 * instances by token without relying on consumer-specific property names.
 */
export function withCaller<P extends BasePlugin>(dep: P, callerCtx: Context): P {
	const view = Object.create((dep as any)[PLUGIN_CTX])
	view.caller = callerCtx
	return Object.create(dep, {
		ctx: {
			value: view,
			writable: false,
			enumerable: false,
			configurable: false,
		},
	})
}

