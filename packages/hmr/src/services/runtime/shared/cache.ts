export function resolveCacheLimit(raw: unknown, fallback: number) {
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw))
	if (typeof raw === 'string') {
		const n = Number.parseInt(raw, 10)
		if (Number.isFinite(n)) return Math.max(0, n)
	}
	return fallback
}

export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
	if (limit <= 0) return
	map.set(key, value)
	if (map.size <= limit) return
	const first = map.keys().next()
	if (!first.done) map.delete(first.value)
}
