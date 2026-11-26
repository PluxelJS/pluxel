import { createClient, LibsqlError } from '@libsql/client/sqlite3'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { DrizzleQueryError, sql } from 'drizzle-orm'
import { LibSQLSession, LibSQLTransaction } from 'drizzle-orm/libsql/session'
import { drizzle } from 'drizzle-orm/libsql/sqlite3'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import type { DatabaseArtifact } from '../artifact'
import { assertMigrationPrefix } from '../history'
import { validateMigrationArtifact } from '../node-migrations'

const dialect = new SQLiteAsyncDialect()
type MigrationTransaction = LibSQLTransaction<Record<string, never>, Record<string, never>>

/** The outer write transaction owns commit and rollback for the entire migration. */
class MigrationSession extends LibSQLSession<Record<string, never>, Record<string, never>> {
	override async transaction<T>(work: (tx: MigrationTransaction) => T | Promise<T>): Promise<T> {
		return work(new LibSQLTransaction('async', dialect, this, undefined))
	}
}

export async function openLocalDatabase<Schema extends Record<string, unknown>>(
	directory: string,
	ownerId: string,
	schema: Schema,
	artifact: DatabaseArtifact,
) {
	validateMigrationArtifact(artifact)
	await mkdir(directory, { recursive: true })
	const file = createHash('sha256')
		.update(JSON.stringify([ownerId, artifact.lineage]))
		.digest('hex')
	const { client, tx } = await openForMigration(
		pathToFileURL(join(directory, `${file}.sqlite`)).href,
		artifact,
		ownerId,
	)
	try {
		if (tx) {
			try {
				await migrate(new MigrationSession(client, dialect, undefined, {}, tx), artifact, ownerId)
				await tx.commit()
			} finally {
				tx.close()
			}
		}
		await client.execute('PRAGMA foreign_keys = ON')
		return {
			db: drizzle(client, { schema }),
			supportsInteractiveTransactions: true,
			close: () => client.close(),
		}
	} catch (error) {
		client.close()
		throw error
	}
}

async function openForMigration(url: string, artifact: DatabaseArtifact, ownerId: string) {
	// The local driver's native busy timeout blocks the event loop. Yield so another
	// Host in this process can finish its transaction and release the SQLite lock.
	const deadline = performance.now() + 5_000
	let delay = 5
	for (;;) {
		const client = createClient({ url })
		try {
			const reader = new LibSQLSession(client, dialect, undefined, {}, undefined)
			if (await isCurrent(reader, artifact, ownerId)) return { client }
			// This client has one open connection until handed to the owner. SQLite only
			// permits changing foreign_keys outside a transaction. Kit rebuilds parent
			// tables with DROP, which would otherwise cascade into existing children.
			await client.execute('PRAGMA foreign_keys = OFF')
			const tx = await client.transaction('write')
			return { client, tx }
		} catch (error) {
			// libSQL can retain a busy BEGIN statement on this connection after rejection.
			client.close()
			const cause = error instanceof DrizzleQueryError ? error.cause : error
			const remaining = deadline - performance.now()
			if (!(cause instanceof LibsqlError) || cause.code !== 'SQLITE_BUSY' || remaining <= 0)
				throw error
			await wait(Math.min(delay, remaining))
			delay = Math.min(delay * 2, 100)
		}
	}
}

async function isCurrent(
	session: Pick<MigrationSession, 'get' | 'all'>,
	artifact: DatabaseArtifact,
	ownerId: string,
): Promise<boolean> {
	const state = await session.get<{ journal: number; populated: number }>(
		sql`SELECT
			EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '__drizzle_migrations') AS journal,
			EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*') AS populated`,
	)
	if (state.journal) {
		// SQLite accepts Drizzle's SERIAL PRIMARY KEY as a nullable column.
		// rowid gives insertion order even when the journal's id is NULL.
		const rows = await session.all<{ created_at: number | string | null; hash: string }>(
			sql`SELECT created_at, hash FROM __drizzle_migrations ORDER BY rowid`,
		)
		assertMigrationPrefix(rows, artifact, ownerId)
		return rows.length === artifact.migrations.length
	} else if (state.populated) {
		throw new Error(`[pluxel/sqlite] existing database for "${ownerId}" has no Drizzle journal`)
	}
	return false
}

async function migrate(session: MigrationSession, artifact: DatabaseArtifact, ownerId: string) {
	// A different Host may have applied the pending entries before we acquired the write lock.
	if (await isCurrent(session, artifact, ownerId)) return
	await dialect.migrate([...artifact.migrations], session)
	const [violation] = await session.all<{ table: string; parent: string }>(
		sql`SELECT "table", parent FROM pragma_foreign_key_check LIMIT 1`,
	)
	if (violation) {
		throw new Error(
			`[pluxel/sqlite] migration violates foreign key from "${violation.table}" to "${violation.parent}" for "${ownerId}"`,
		)
	}
}
