import { BasePlugin } from '@pluxel/runtime'

export interface CacheValue<V> {
	value: V
	/** Remaining lifetime in milliseconds. Omit or use `0` for no expiry. */
	ttlMs?: number
}

/**
 * Minimal adapter contract for Redis, a database, or another async cache.
 * Values are intentionally opaque: serialization belongs to the adapter.
 */
export interface CacheBackendStore {
	get<V>(key: string): Promise<CacheValue<V> | undefined>
	set<V>(key: string, value: V, options: Readonly<{ ttlMs: number }>): Promise<void>
	delete(key: string): Promise<void>
	clear?(prefix: string): Promise<void>
}

/** Polymorphic async backend token implemented by memory, Redis, database, or other plugins. */
export abstract class CacheBackend extends BasePlugin implements CacheBackendStore {
	abstract get<V>(key: string): Promise<CacheValue<V> | undefined>
	abstract set<V>(key: string, value: V, options: Readonly<{ ttlMs: number }>): Promise<void>
	abstract delete(key: string): Promise<void>
	abstract clear?(prefix: string): Promise<void>
}
