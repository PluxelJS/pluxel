const deepFrozenValues = new WeakSet<object>()

export function deepFreeze<T>(value: T): T {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
	if (deepFrozenValues.has(value)) return value
	for (const key of Reflect.ownKeys(value)) {
		const current = (value as Record<PropertyKey, unknown>)[key]
		if (current && (typeof current === 'object' || typeof current === 'function')) {
			deepFreeze(current)
		}
	}
	if (!Object.isFrozen(value)) Object.freeze(value)
	deepFrozenValues.add(value)
	return value
}

export function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return true
	if (deepFrozenValues.has(value)) return true
	if (!Object.isFrozen(value)) return false
	if (seen.has(value)) return true
	seen.add(value)
	for (const key of Reflect.ownKeys(value)) {
		if (!isDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen)) return false
	}
	deepFrozenValues.add(value)
	return true
}
