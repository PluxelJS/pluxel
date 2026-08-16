import type { Context } from '@pluxel/context'
import type { BasePlugin } from '../composition/BasePlugin'
import { PLUGIN_CTX } from '../composition/symbols'
import type { Identifier } from '../types'

type AnyFn = (...args: unknown[]) => unknown
type Registry = { getInstance: <T>(id: Identifier<T>) => T | undefined }
type AnyRecord = Record<PropertyKey, unknown>

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
	const baseCtx = (dep as unknown as AnyRecord)[PLUGIN_CTX]
	if (!baseCtx || typeof baseCtx !== 'object') {
		throw new Error('[pluxel/core] BasePlugin instance missing internal ctx')
	}

	const view = Object.create(baseCtx as object) as Context
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

function getCallerCtx(self: unknown): Context {
	if (!self || (typeof self !== 'object' && typeof self !== 'function')) {
		throw new Error('[pluxel/core] Decorator runtime requires a BasePlugin instance with ctx')
	}
	const ctx = (self as { ctx?: unknown }).ctx
	if (!ctx || typeof ctx !== 'object') {
		throw new Error('[pluxel/core] Decorator runtime requires a BasePlugin instance with ctx')
	}
	return ctx as Context
}

function getRegistry(ctx: unknown): Registry {
	const registry = (ctx as { registry?: unknown } | null)?.registry
	if (!registry || typeof (registry as { getInstance?: unknown }).getInstance !== 'function') {
		throw new Error('[pluxel/core] Decorator runtime requires ctx.registry.getInstance')
	}
	return registry as Registry
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
	if (!self || (typeof self !== 'object' && typeof self !== 'function')) {
		throw new Error('[pluxel/core] Decorator runtime requires a plugin instance')
	}
	const plugin = self as AnyRecord
	const ctx = getCallerCtx(plugin)
	const registry = getRegistry(ctx)

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
	fn: (this: unknown, original: AnyFn, dep: T, key: string | symbol, ...args: unknown[]) => unknown,
): MethodDecorator {
	return (_target, key, desc) => {
		const original = (desc as PropertyDescriptor | undefined)?.value
		if (typeof original !== 'function') {
			throw new TypeError(
				`pluginMethodDecorator(${String(depToken)}) can only decorate methods: ${String(key)}`,
			)
		}

		;(desc as PropertyDescriptor).value = function (...args: unknown[]) {
			const dep = resolvePluginDependency(this, depToken)
			return fn.call(this, original, dep, key, ...args)
		}
	}
}
