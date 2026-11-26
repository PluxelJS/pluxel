import type { D1Database } from '@cloudflare/workers-types'
import type { DatabaseArtifact } from '../artifact'
import { assertMigrationPrefix } from '../history'

type OwnerRow = { owner: string; lineage: string; evolution: string }
type JournalRow = { created_at: number | string | null; hash: string }

export const ownerTable = '__pluxel_d1_owner'
export const journalTable = '__drizzle_migrations'

export async function verifyD1History(
	binding: D1Database,
	owner: string,
	artifact: DatabaseArtifact,
	journalExists = true,
): Promise<number> {
	const statements = [
		binding.prepare(`SELECT owner, lineage, evolution FROM ${ownerTable} WHERE id = 1`),
	]
	if (journalExists) {
		// Drizzle's D1 migrator uses SERIAL PRIMARY KEY, which does not alias SQLite's rowid.
		statements.push(binding.prepare(`SELECT created_at, hash FROM ${journalTable} ORDER BY rowid`))
	}
	const [identity, journal] = await binding.batch<OwnerRow | JournalRow>(statements)
	const row = identity!.results[0] as OwnerRow | undefined
	if (
		row?.owner !== owner ||
		row.lineage !== artifact.lineage ||
		row.evolution !== artifact.evolution
	) {
		throw new Error(
			`[pluxel/sqlite/d1] binding belongs to ${JSON.stringify(row ?? null)}; expected owner "${owner}", lineage "${artifact.lineage}" and evolution "${artifact.evolution}". Provision a separate D1 database for a different owner or lineage.`,
		)
	}
	const rows = (journal?.results ?? []) as JournalRow[]
	assertMigrationPrefix(rows, artifact, owner)
	return rows.length
}
