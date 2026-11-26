import type { D1Database } from '@cloudflare/workers-types'
import { formatPluginNodeReference, parsePluginNodeReference } from '@pluxel/core'
import { readDatabaseHistory, writeDatabaseHistory } from '@pluxel/rolldown/database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from 'drizzle-orm/d1/migrator'
import type { DatabaseEvolution } from '../../sqlite'
import { assertD1ForeignKeys } from './d1-foreign-keys'
import { journalTable, ownerTable, verifyD1History } from './d1-state'

/** Run once per physical D1 database in a serialized deployment job. */
export async function migrateD1(
	binding: D1Database,
	options: { owner: string; migrationsFolder: string; evolution?: DatabaseEvolution },
): Promise<void> {
	const { owner, migrationsFolder, evolution = 'migrations' } = options
	if (formatPluginNodeReference(parsePluginNodeReference(owner)) !== owner)
		throw new TypeError(
			'[pluxel/sqlite/d1] migrateD1 requires the canonical plugin owner reference',
		)
	const history = await readDatabaseHistory(migrationsFolder, 'sqlite')
	const { migrations, lineage, tags } = history
	if (migrations.length === 0)
		throw new Error('[pluxel/sqlite/d1] the release has no SQLite migrations')
	if (
		evolution !== 'migrations' &&
		(evolution !== 'reset-on-schema-change' ||
			migrations.length !== 1 ||
			migrations[0]!.folderMillis !== 0)
	) {
		throw new Error(
			'[pluxel/sqlite/d1] reset-on-schema-change requires one baseline at timestamp 0',
		)
	}
	const artifact = { lineage, evolution, migrations }
	const { results } = await binding
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT GLOB 'sqlite_*' AND name <> '_cf_KV'",
		)
		.all<{ name: string }>()
	const tables = new Set(results.map(({ name }) => name))
	if (tables.has('d1_migrations'))
		throw new Error(
			'[pluxel/sqlite/d1] this binding has a Wrangler d1_migrations ledger; choose a dedicated D1 database',
		)
	const hasOwner = tables.has(ownerTable)
	if (!hasOwner && tables.size > 0) {
		throw new Error(
			`[pluxel/sqlite/d1] refusing to claim a nonempty D1 database containing "${tables.values().next().value}"`,
		)
	}
	if (hasOwner && !tables.has(journalTable) && tables.size > 1) {
		throw new Error(
			`[pluxel/sqlite/d1] the dedicated database has application tables but is missing its ${journalTable} ledger`,
		)
	}
	const count = hasOwner
		? await verifyD1History(binding, owner, artifact, tables.has(journalTable))
		: 0
	if (count === migrations.length) return
	for (let i = count; i < migrations.length; i++) assertD1ForeignKeys(migrations[i]!, tags[i]!)
	// The native D1 migrator takes a directory. Hand it the journal and SQL that were checked
	// before the D1 requests, even if deployment files have since changed.
	const snapshot = await mkdtemp(join(tmpdir(), 'pluxel-d1-release-'))
	try {
		await writeDatabaseHistory(snapshot, history)
		if (!hasOwner) {
			await binding.batch([
				binding.prepare(
					`CREATE TABLE ${ownerTable} (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, lineage TEXT NOT NULL, evolution TEXT NOT NULL)`,
				),
				binding
					.prepare(`INSERT INTO ${ownerTable} (id, owner, lineage, evolution) VALUES (1, ?, ?, ?)`)
					.bind(owner, lineage, evolution),
			])
		}
		await migrate(drizzle(binding), { migrationsFolder: snapshot })
	} finally {
		await rm(snapshot, { recursive: true, force: true })
	}
	const applied = await verifyD1History(binding, owner, artifact)
	if (applied !== migrations.length) {
		throw new Error(
			`[pluxel/sqlite/d1] Drizzle applied ${applied} of ${migrations.length} migrations for "${owner}"`,
		)
	}
}
