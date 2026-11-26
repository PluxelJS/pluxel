import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { DatabaseAdapter } from '../coordinator'

export async function createPgliteDatabaseAdapter(
	config: PGliteOptions | PGlite,
): Promise<DatabaseAdapter> {
	const borrowed = 'query' in config
	const dataDir = config.dataDir
	if (!borrowed && !config.fs && dataDir !== undefined && !dataDir.includes('://'))
		await mkdir(dirname(dataDir), { recursive: true })
	const client = borrowed ? config : new PGlite(config)
	try {
		await client.waitReady
		return {
			driver: 'pglite',
			db: drizzle({ client }),
			withSchema: (schema) => drizzle({ client, schema }),
			concurrency: 1,
			async close() {
				if (!borrowed) await client.close()
			},
		}
	} catch (cause) {
		let failure = new Error(
			`PGlite initialization failed${dataDir === undefined ? '' : ` for ${JSON.stringify(dataDir)}`}; inspect the native error cause before retrying the Host.`,
			{ cause },
		)
		if (!borrowed) {
			try {
				await client.close()
			} catch (cleanupError) {
				failure = new AggregateError(
					[failure, cleanupError],
					'PGlite adapter setup and cleanup failed',
					{ cause },
				)
			}
		}
		throw failure
	}
}
