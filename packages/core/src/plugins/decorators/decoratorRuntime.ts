import type { BasePlugin } from '../composition/BasePlugin'
import { createCallerGenerationView } from '../composition/caller-view'
import type { Identifier } from '../types'
import { requirePluginService } from '../../internal/plugin-service'

type AnyFn = (...args: unknown[]) => unknown
function getCallerCtx(self: unknown) {
	if (!self || (typeof self !== 'object' && typeof self !== 'function')) {
		throw new Error('[pluxel/core] Decorator runtime requires a BasePlugin instance with ctx')
	}
	const ctx = (self as { ctx?: unknown }).ctx
	if (!ctx || typeof ctx !== 'object') {
		throw new Error('[pluxel/core] Decorator runtime requires a BasePlugin instance with ctx')
	}
	return ctx as import('../../context/Context').Context
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
	const plugin = self as Record<PropertyKey, unknown>
	const ctx = getCallerCtx(plugin)
	const registry = requirePluginService(ctx)

	const raw = registry.getInstance(token) as T | undefined
	if (!raw) {
		throw new Error(`[pluxel/core] Missing dependency instance for token: ${String(token)}`)
	}

	return createCallerGenerationView(raw, ctx)
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
