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

type SieveState<K> = {
	hand: Iterator<K> | null
	refs: Set<K>
}

const sieveStateByMap = new WeakMap<Map<unknown, unknown>, SieveState<unknown>>()

function getSieveState<K, V>(map: Map<K, V>): SieveState<K> {
	const existing = sieveStateByMap.get(map as unknown as Map<unknown, unknown>) as
		| SieveState<K>
		| undefined
	if (existing) return existing
	const next: SieveState<K> = { hand: null, refs: new Set() }
	sieveStateByMap.set(
		map as unknown as Map<unknown, unknown>,
		next as unknown as SieveState<unknown>,
	)
	return next
}

function sieveTouch<K, V>(map: Map<K, V>, key: K) {
	getSieveState(map).refs.add(key)
}

function sieveDelete<K, V>(map: Map<K, V>, key: K) {
	map.delete(key)
	const state = sieveStateByMap.get(map as unknown as Map<unknown, unknown>) as
		| SieveState<K>
		| undefined
	if (state) state.refs.delete(key)
}

function sieveEvictIfNeeded<K, V>(map: Map<K, V>, limit: number) {
	if (limit <= 0) return
	if (map.size <= limit) return

	const state = getSieveState(map)
	while (map.size > limit) {
		if (!state.hand) state.hand = map.keys()
		const next = state.hand.next()
		if (next.done) {
			state.hand = null
			continue
		}
		const key = next.value
		if (!map.has(key)) {
			state.refs.delete(key)
			continue
		}
		if (state.refs.has(key)) {
			state.refs.delete(key)
			continue
		}
		map.delete(key)
		state.refs.delete(key)
	}
}

/**
 * Clears the per-map sieve state used by `getOrCreatePromise` / `getOrCreateCachedValue`.
 *
 * Call this when you call `map.clear()` to avoid keeping stale reference bits in memory.
 */
export function clearSieveState<K, V>(map: Map<K, V>) {
	const state = sieveStateByMap.get(map as unknown as Map<unknown, unknown>) as
		| SieveState<K>
		| undefined
	if (!state) return
	state.hand = null
	state.refs.clear()
}

/**
 * A small "SIEVE / second-chance" cache primitive:
 * - access does not reorder entries;
 * - eviction scans a circular hand and gives referenced entries a second chance.
 */
export function getOrCreateCachedValue<K, V>(
	map: Map<K, V>,
	key: K,
	create: () => V,
	opts?: { limit?: number; evictIf?: (value: V) => boolean },
): V {
	const limit = opts?.limit ?? 0
	if (limit <= 0) return create()

	if (map.has(key)) {
		const cached = map.get(key) as V
		sieveTouch(map, key)
		return cached
	}

	const value = create()
	if (opts?.evictIf?.(value)) return value

	map.set(key, value)
	sieveTouch(map, key)
	sieveEvictIfNeeded(map, limit)
	return value
}

export function getOrCreatePromise<K, V>(
	map: Map<K, Promise<V>>,
	key: K,
	create: () => Promise<V>,
	opts?: { limit?: number; evictIf?: (value: V) => boolean },
): Promise<V> {
	const limit = opts?.limit ?? 0
	if (limit <= 0) return create()

	const cached = map.get(key)
	if (cached) {
		sieveTouch(map, key)
		return cached
	}

	const promise = create()
		.then((value) => {
			if (opts?.evictIf?.(value)) sieveDelete(map, key)
			return value
		})
		.catch((error) => {
			sieveDelete(map, key)
			throw error
		})

	map.set(key, promise)
	sieveTouch(map, key)
	sieveEvictIfNeeded(map, limit)
	return promise
}
