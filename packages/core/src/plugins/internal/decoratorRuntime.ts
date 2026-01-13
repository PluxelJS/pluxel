import type { Context } from '@pluxel/context'
import type { Identifier } from '../../container'
import type { BasePlugin } from './BasePlugin'
import { PLUGIN_CTX } from './BasePlugin'
import { requirePluginDependency } from './PluginDecorator'

type AnyFn = (...args: any[]) => any

// Cache of caller-injected dependency views on each plugin instance.
// Symbol.for so HMR and multi-bundle scenarios can share the same key safely.
const DEP_CACHE = Symbol.for('pluxel:plugin:decorators:depCache')

/**
 * Create a "caller-injected" view of a dependency plugin instance.
 *
 * This mirrors the constructor-injection behavior in PluginDefinitions:
 * the returned object delegates to `dep` but overrides `ctx` so that
 * `dep.ctx.caller === callerCtx`.
 */
function withCaller<P extends BasePlugin>(dep: P, callerCtx: Context): P {
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

function getCallerCtx(self: any): Context {
	const ctx = self?.ctx
	if (!ctx || typeof ctx !== 'object') {
		throw new Error('[pluxel/core] Decorator runtime requires a BasePlugin instance (missing ctx)')
	}
	return ctx as Context
}

function getRegistry(ctx: any): any {
	const registry = ctx?.registry
	if (!registry || typeof registry.getInstance !== 'function') {
		throw new Error('[pluxel/core] Decorator runtime requires ctx.registry.getInstance')
	}
	return registry
}

/**
 * Resolve a dependency plugin instance by DI token, and inject caller context
 * (so dep.ctx.caller points at the current plugin ctx), matching ctor injection.
 *
 * This avoids relying on consumer-defined property names (e.g. `this.kv`).
 */
export function resolvePluginDependency<T extends BasePlugin>(
	self: unknown,
	token: Identifier<T>,
): T {
	const plugin = self as any
	const ctx = getCallerCtx(plugin)
	const registry = getRegistry(ctx as any)

	let cache = plugin[DEP_CACHE] as Map<unknown, unknown> | undefined
	if (!cache) {
		cache = new Map()
		Object.defineProperty(plugin, DEP_CACHE, {
			value: cache,
			writable: false,
			enumerable: false,
			configurable: false,
		})
	}

	if (cache.has(token)) return cache.get(token) as T

	const raw = registry.getInstance(token) as T | undefined
	if (!raw) {
		throw new Error(`[pluxel/core] Missing dependency instance for token: ${String(token)}`)
	}

	const view = withCaller(raw, ctx)
	cache.set(token, view)
	return view as T
}

/**
 * Helper for writing cross-plugin method decorators correctly and efficiently:
 * - records required dependency token at decoration time;
 * - resolves dependency by token at call time (caller-injected and cached);
 * - passes `key` without allocating an extra metadata object.
 *
 * Typical usage in an external plugin package:
 *
 * ```ts
 * // Dependency plugin exports decorators bound to its own token:
 * export const Cached = () =>
 *   pluginMethodDecorator(KvToken, async function (original, kv, key, ...args) {
 *     return await original.apply(this, args)
 *   })
 *
 * // Consumer plugin usage:
 * //   @Cached()
 * //   async getUser(id: string) { ... }
 * ```
 */
export function pluginMethodDecorator<T extends BasePlugin>(
	depToken: Identifier<T>,
	fn: (this: any, original: AnyFn, dep: T, key: string | symbol, ...args: any[]) => any,
): MethodDecorator {
	return (target, key, desc) => {
		requirePluginDependency(target, depToken as any)

		const original = (desc as PropertyDescriptor | undefined)?.value
		if (typeof original !== 'function') {
			throw new Error(`pluginMethodDecorator(${String(depToken)}) can only decorate methods: ${String(key)}`)
		}

		;(desc as PropertyDescriptor).value = function (...args: any[]) {
			const dep = resolvePluginDependency(this, depToken)
			return fn.call(this, original, dep, key, ...args)
		}
	}
}
