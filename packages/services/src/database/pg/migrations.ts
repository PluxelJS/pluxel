import { sql } from 'drizzle-orm'
import {
	PgDialect,
	PgSession,
	type PgQueryResultHKT,
	type PgTransaction,
} from 'drizzle-orm/pg-core'
import type { DatabaseArtifact } from '../artifact'
import { SYSTEM_SCHEMA } from './system'
import { assertMigrationPrefix } from '../history'

type MigrationTransaction = PgTransaction<PgQueryResultHKT>
const dialect = new PgDialect()

/** The dialect opens a transaction. Inside owner preparation that must be a savepoint
 * on the transaction holding the owner lock, including on a pooled PostgreSQL connection. */
class MigrationSession extends PgSession {
	readonly prepareQuery: PgSession['prepareQuery']
	readonly transaction: PgSession['transaction']

	constructor(tx: MigrationTransaction) {
		super(dialect)
		const session = tx._.session
		this.prepareQuery = session.prepareQuery.bind(session)
		this.transaction = tx.transaction.bind(tx)
	}
}

/** Returns whether this transaction applied any plugin SQL. */
export async function migrateDatabaseInstance(
	tx: MigrationTransaction,
	instanceId: string,
	artifact: DatabaseArtifact,
	state: 'new' | 'active',
): Promise<boolean> {
	const table = `drizzle_${instanceId.replaceAll('-', '')}`
	const session = new MigrationSession(tx)
	if (state === 'active') {
		const [relation] = await session.all<{ present: boolean }>(
			sql`SELECT to_regclass(${`${SYSTEM_SCHEMA}.${table}`}) IS NOT NULL AS present`,
		)
		if (!relation?.present) {
			throw new Error(
				`[pluxel/pg] active instance ${instanceId} has no Drizzle journal; restore or convert its deployed migration history before retrying`,
			)
		}
		const rows = await session.all<{ created_at: string | number | null; hash: string }>(
			sql`SELECT created_at, hash FROM ${sql.identifier(SYSTEM_SCHEMA)}.${sql.identifier(table)} ORDER BY id`,
		)
		if (artifact.evolution === 'reset-on-schema-change' && rows.length === 0) {
			throw new Error(`[pluxel/pg] missing reset baseline for active instance ${instanceId}`)
		}
		assertMigrationPrefix(rows, artifact, instanceId)
		if (rows.length === artifact.migrations.length) return false
	}

	await dialect.migrate([...artifact.migrations], session, {
		// The shared Drizzle config type also covers its filesystem-based entry point.
		migrationsFolder: '',
		migrationsSchema: SYSTEM_SCHEMA,
		migrationsTable: table,
	})
	return true
}
