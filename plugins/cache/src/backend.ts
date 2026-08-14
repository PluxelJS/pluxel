import { BasePlugin } from '@pluxel/runtime'

export interface CacheValue<V> {
	/** A hit value. `null` is valid; `undefined` is forbidden. */
	value: V
	/** Remaining lifetime in milliseconds. Omit or use `0` for no expiry. */
	ttlMs?: number
}

/**
 * Minimal adapter contract for Redis, a database, or another async cache.
 * Values are intentionally opaque: serialization belongs to the adapter.
 */
export interface CacheBackendStore {
	/** Return `undefined` only for a miss. Backend failures must reject. */
	get<V>(key: string): Promise<CacheValue<V> | undefined>
	/** Store one defined value. `ttlMs: 0` means no expiry. */
	set<V>(key: string, value: V, options: Readonly<{ ttlMs: number }>): Promise<void>
	/** Idempotently remove one key. Backend failures must reject. */
	delete(key: string): Promise<void>
	/** Idempotently remove every key starting with the exact managed prefix. */
	clear(prefix: string): Promise<void>
}

/** Polymorphic async backend token implemented by memory, Redis, database, or other plugins. */
export abstract class CacheBackend extends BasePlugin implements CacheBackendStore {
	abstract get<V>(key: string): Promise<CacheValue<V> | undefined>
	abstract set<V>(key: string, value: V, options: Readonly<{ ttlMs: number }>): Promise<void>
	abstract delete(key: string): Promise<void>
	abstract clear(prefix: string): Promise<void>
}
