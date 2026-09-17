import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core/session'

export type ManagedDatabaseAdapter = {
	driver: 'pglite' | 'postgres'
	db: PgDatabase<PgQueryResultHKT, any>
	concurrency: number
	close(): Promise<void>
}
