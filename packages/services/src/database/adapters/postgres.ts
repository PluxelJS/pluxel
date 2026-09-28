import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { PostgresOptions } from '../postgres'
import { attachPostgresPoolErrorHandler } from './shared'
import type { DatabaseAdapter } from '../service'

export async function createPostgresDatabaseAdapter(
	config: PostgresOptions,
	onPoolError: (error: Error) => void,
): Promise<DatabaseAdapter> {
	const concurrency = config.pool?.max ?? 10
	const pool = new Pool({
		connectionString: config.connectionString,
		max: concurrency,
		idleTimeoutMillis: config.pool?.idleTimeoutMs,
		connectionTimeoutMillis: config.pool?.connectionTimeoutMs,
		ssl:
			config.tls === undefined
				? undefined
				: config.tls === 'verify-full'
					? { rejectUnauthorized: true }
					: { rejectUnauthorized: false },
	})
	attachPostgresPoolErrorHandler(pool, onPoolError)
	return {
		driver: 'postgres',
		db: drizzle(pool),
		concurrency,
		close: async () => await pool.end(),
	}
}
