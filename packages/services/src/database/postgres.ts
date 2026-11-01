import type { Pool, PoolConfig } from 'pg'
import type { DatabaseBackend } from './service'

/** Native pg configuration creates a Host-owned pool on first use; an existing pool is borrowed. */
export function postgres(options: PoolConfig | Pool = {}): DatabaseBackend {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[pluxel/database] postgres requires pg PoolConfig or Pool')
	if (
		'max' in options &&
		options.max !== undefined &&
		(!Number.isInteger(options.max) || options.max <= 0)
	)
		throw new TypeError('[pluxel/database] pg max must be a positive integer')
	return async (onError) => {
		const { createPostgresDatabaseAdapter } = await import('#pluxel/database-driver/postgres')
		return createPostgresDatabaseAdapter(options, onError)
	}
}
