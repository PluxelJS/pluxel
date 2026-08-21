import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context as CoreContext } from '@pluxel/core'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { DatabaseConfig } from '../DatabaseService'
import type { ManagedDatabaseAdapter } from './types'

type PgliteDatabaseConfig = Extract<DatabaseConfig, { driver: 'pglite' }>

export async function createPgliteDatabaseAdapter(
	config: PgliteDatabaseConfig | undefined,
	persistence: CoreContext.Config['persistence'],
): Promise<ManagedDatabaseAdapter> {
	const dataDir = config?.dataDir ?? defaultPgliteDataDir(persistence)
	if (!dataDir.includes('://')) await mkdir(dirname(dataDir), { recursive: true })
	const client = new PGlite(dataDir)
	await client.waitReady
	return {
		driver: 'pglite',
		db: drizzle(client),
		concurrency: 1,
		close: async () => await client.close(),
	}
}

function defaultPgliteDataDir(persistence: CoreContext.Config['persistence']): string {
	if (typeof persistence === 'string') return join(persistence, 'database', 'pglite')
	if (persistence && typeof persistence === 'object' && persistence.mode === 'memory') {
		return 'memory://'
	}
	return join('.pluxel', 'persistence', 'database', 'pglite')
}
