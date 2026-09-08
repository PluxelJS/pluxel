import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { DatabaseConfig } from '../DatabaseService'
import type { PersistenceServiceConfig } from '../persistence/PersistenceService'
import type { ManagedDatabaseAdapter } from './types'

type PgliteDatabaseConfig = Extract<DatabaseConfig, { driver: 'pglite' }>

export async function createPgliteDatabaseAdapter(
	config: PgliteDatabaseConfig | undefined,
	persistence: PersistenceServiceConfig | undefined,
): Promise<ManagedDatabaseAdapter> {
	const dataDir = config?.dataDir ?? defaultPgliteDataDir(persistence)
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

function defaultPgliteDataDir(persistence: PersistenceServiceConfig | undefined): string {
	if (typeof persistence === 'string') return join(persistence, 'database', 'pglite')
	if (persistence && typeof persistence === 'object' && persistence.mode === 'memory') {
		return 'memory://'
	}
	return join('.pluxel', 'persistence', 'database', 'pglite')
}
