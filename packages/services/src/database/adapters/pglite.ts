import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { PgliteOptions } from '../pglite'
import type { DatabaseAdapter } from '../service'

export async function createPgliteDatabaseAdapter(config: PgliteOptions): Promise<DatabaseAdapter> {
	const dataDir = config.dataDir
	if (!dataDir.includes('://')) await mkdir(dirname(dataDir), { recursive: true })
	const client = new PGlite(dataDir)
	try {
		await client.waitReady
	} catch (cause) {
		throw new Error(
			`PGlite initialization failed for ${JSON.stringify(dataDir)}. Stop other hosts using this directory and restart the host; retrying a Plugin cannot recreate the failed database backend.`,
			{ cause },
		)
	}
	return {
		driver: 'pglite',
		db: drizzle(client),
		concurrency: 1,
		close: async () => await client.close(),
	}
}
