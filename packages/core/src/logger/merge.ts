import { createDefu } from 'defu'

const defuNoArrayConcat = createDefu((object, key, value) => {
	if (Array.isArray(value) && Array.isArray((object as any)[key])) {
		;(object as any)[key] = value
		return true
	}
})

/**
 * Deep-merge defaults with **array replacement** semantics (no concat).
 *
 * - `undefined` / `null` values in `overrides` are ignored (defu behavior)
 * - arrays in `overrides` replace defaults
 */
export function mergeDefaults<T extends Record<string | number | symbol, any>>(
	overrides: Partial<T> | undefined,
	defaults: T,
): T {
	return defuNoArrayConcat((overrides ?? {}) as any, defaults as any) as T
}
