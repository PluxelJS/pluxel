import type { DatabaseBackend } from './service'
export type PostgresOptions = Readonly<{
	connectionString: string
	pool?: Readonly<{ max?: number; idleTimeoutMs?: number; connectionTimeoutMs?: number }>
	tls?: 'require' | 'verify-full'
}>
/** Select only the PostgreSQL backend. Loading and pool creation happen on first use. */
export function postgres(options: PostgresOptions): DatabaseBackend {
	if (!options || typeof options.connectionString !== 'string' || !options.connectionString.trim())
		throw new TypeError('[pluxel/database] postgres requires connectionString')
	if (
		options.pool?.max !== undefined &&
		(!Number.isInteger(options.pool.max) || options.pool.max <= 0)
	)
		throw new TypeError('[pluxel/database] pool.max must be a positive integer')
	const snapshot = Object.freeze({
		...options,
		...(options.pool ? { pool: Object.freeze({ ...options.pool }) } : {}),
	})
	return async (onError) => {
		const { createPostgresDatabaseAdapter } = await import('#pluxel/database-driver/postgres')
		return createPostgresDatabaseAdapter(snapshot, onError)
	}
}
