export const deepFreeze = <T>(value: T): T => {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
	if (Object.isFrozen(value)) return value

	for (const key of Reflect.ownKeys(value)) {
		const current = (value as Record<PropertyKey, unknown>)[key]
		if (current && (typeof current === 'object' || typeof current === 'function')) {
			deepFreeze(current)
		}
	}

	return Object.freeze(value)
}
