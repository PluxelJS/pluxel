export function stringifyUnknown(value: unknown, fallback = ''): string {
	if (value == null) return value === null ? 'null' : fallback
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean'
	) {
		return String(value)
	}
	if (typeof value === 'symbol') {
		return value.description ? `Symbol(${value.description})` : 'Symbol()'
	}
	if (typeof value === 'function') {
		return value.name ? `[Function ${value.name}]` : '[Function]'
	}
	if (value instanceof Error) return value.message || fallback
	try {
		return JSON.stringify(value) ?? fallback
	} catch {
		return fallback
	}
}
