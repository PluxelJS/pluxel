import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { DatabaseConfig } from '../DatabaseService'
import { attachPostgresPoolErrorHandler } from './shared'
import type { ManagedDatabaseAdapter } from './types'

type PostgresDatabaseConfig = Extract<DatabaseConfig, { driver: 'postgres' }>

export async function createPostgresDatabaseAdapter(
	config: PostgresDatabaseConfig,
	onPoolError: (error: Error) => void,
): Promise<ManagedDatabaseAdapter> {
	const pool = new Pool({
		connectionString: config.connectionString,
		max: config.pool?.max ?? 10,
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
		concurrency: config.pool?.max ?? 10,
		close: async () => await pool.end(),
	}
}
