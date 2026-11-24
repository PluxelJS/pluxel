import type { Pool, PoolConfig } from 'pg'
import type { HostService } from '@pluxel/host'
import { installPg } from './install'

/** Native pg configuration creates a Host-owned pool on first use; an existing pool is borrowed. */
export function postgres(options: PoolConfig | Pool = {}): HostService {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[pluxel/pg] postgres requires pg PoolConfig or Pool')
	if (
		'max' in options &&
		options.max !== undefined &&
		(!Number.isInteger(options.max) || options.max <= 0)
	)
		throw new TypeError('[pluxel/pg] pg max must be a positive integer')
	return installPg(async (onError) => {
		const { createPostgresDatabaseAdapter } = await import('./adapters/postgres')
		return createPostgresDatabaseAdapter(options, onError)
	})
}
