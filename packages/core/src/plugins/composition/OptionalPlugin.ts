import type { PluginConstructor } from '../types'

const OPTIONAL_PLUGIN_REF = Symbol.for('pluxel:plugin:optional-ref')

export type OptionalPluginLoader<T extends PluginConstructor> = () => Promise<T>

/**
 * An opaque reference to a plugin implementation package that may be absent.
 *
 * The loader is intentionally not exposed on the public shape. Pluxel owns its
 * execution so package resolution, graph updates, diagnostics, and HMR remain
 * route-coordinated.
 */
export interface OptionalPluginRef<T extends PluginConstructor> {
	readonly [OPTIONAL_PLUGIN_REF]: T
}

/** Declare a package-optional plugin implementation. */
export function optionalPlugin<T extends PluginConstructor>(
	load: OptionalPluginLoader<T>,
): OptionalPluginRef<T>
export function optionalPlugin<T extends PluginConstructor>(
	load: OptionalPluginLoader<T>,
	packageSpecifier?: string,
): OptionalPluginRef<T> {
	if (typeof load !== 'function') {
		throw new TypeError('[pluxel/core] optionalPlugin() expects a loader function')
	}
	const ref = () => load()
	Object.defineProperty(ref, OPTIONAL_PLUGIN_REF, { value: packageSpecifier ?? true })
	return Object.freeze(ref) as unknown as OptionalPluginRef<T>
}

export function isOptionalPluginRef(value: unknown): value is OptionalPluginRef<PluginConstructor> {
	if (typeof value !== 'function') return false
	const brand = (value as unknown as Record<symbol, unknown>)[OPTIONAL_PLUGIN_REF]
	return brand === true || typeof brand === 'string'
}
