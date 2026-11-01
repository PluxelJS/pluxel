import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type PoolConfig } from 'pg'
import { attachPostgresPoolErrorHandler } from './shared'
import type { DatabaseAdapter } from '../service'

export async function createPostgresDatabaseAdapter(
	config: PoolConfig | Pool,
	onPoolError: (error: Error) => void,
): Promise<DatabaseAdapter> {
	const borrowed = 'query' in config
	const pool = borrowed ? config : new Pool(config)
	let detachErrorHandler: (() => void) | undefined
	try {
		const concurrency = pool.options.max
		if (!Number.isInteger(concurrency) || concurrency <= 0)
			throw new TypeError('[pluxel/database] pg max must be a positive integer')
		detachErrorHandler = attachPostgresPoolErrorHandler(pool, onPoolError)
		return {
			driver: 'postgres',
			db: drizzle({ client: pool }),
			concurrency,
			async close() {
				try {
					if (!borrowed) await pool.end()
				} finally {
					detachErrorHandler?.()
				}
			},
		}
	} catch (cause) {
		detachErrorHandler?.()
		if (!borrowed) {
			let cleanupFailure: { error: unknown } | undefined
			try {
				await pool.end()
			} catch (cleanupError) {
				cleanupFailure = { error: cleanupError }
			}
			if (cleanupFailure) {
				throw new AggregateError(
					[cause, cleanupFailure.error],
					'PostgreSQL adapter setup and cleanup failed',
					{ cause },
				)
			}
		}
		throw cause
	}
}
