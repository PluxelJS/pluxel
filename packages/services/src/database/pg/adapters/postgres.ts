import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type PoolConfig } from 'pg'
import type { DatabaseAdapter } from '../coordinator'

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
			throw new TypeError('[pluxel/pg] pg max must be a positive integer')
		detachErrorHandler = attachPostgresPoolErrorHandler(pool, onPoolError)
		return {
			driver: 'postgres',
			db: drizzle({ client: pool }),
			withSchema: (schema) => drizzle({ client: pool, schema }),
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
		let failure = cause
		if (!borrowed) {
			try {
				await pool.end()
			} catch (cleanupError) {
				failure = new AggregateError(
					[cause, cleanupError],
					'PostgreSQL adapter setup and cleanup failed',
					{ cause },
				)
			}
		}
		throw failure
	}
}

/** Keep pg-pool idle-client failures operational instead of process-fatal. */
export function attachPostgresPoolErrorHandler(
	pool: Pick<Pool, 'on' | 'off'>,
	report: (error: Error) => void,
): () => void {
	const listener = (error: Error): void => {
		try {
			report(error)
		} catch {
			// EventEmitter treats a thrown `error` listener as process-fatal too. Reporting must be a
			// terminal boundary because pg-pool has already removed the failed idle client.
		}
	}
	pool.on('error', listener)
	return () => {
		pool.off('error', listener)
	}
}
