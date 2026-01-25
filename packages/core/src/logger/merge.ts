/**
 * Deep-merge defaults with **array replacement** semantics (no concat).
 *
 * - `undefined` / `null` values in `overrides` are ignored
 * - arrays in `overrides` replace defaults
 */
export function mergeDefaults<T extends object>(
	overrides: Partial<T> | undefined,
	defaults: T,
): T {
	return mergeNode(overrides ?? ({} as Partial<T>), defaults) as T
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function mergeNode(override: unknown, fallback: unknown): unknown {
	if (override == null) return fallback
	if (Array.isArray(override)) return override

	if (isPlainObject(override) && isPlainObject(fallback)) {
		const out = Object.create(Object.getPrototypeOf(fallback) ?? Object.prototype) as Record<
			PropertyKey,
			unknown
		>

		// Defaults first.
		for (const key of Reflect.ownKeys(fallback)) {
			out[key] = (fallback as Record<PropertyKey, unknown>)[key]
		}

		// Apply overrides (deep merge for plain objects; arrays replace).
		for (const key of Reflect.ownKeys(override)) {
			const v = (override as Record<PropertyKey, unknown>)[key]
			if (v == null) continue
			out[key] = mergeNode(v, out[key])
		}

		return out
	}

	return override
}
