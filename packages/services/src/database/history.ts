import type { DatabaseArtifact } from './artifact'

/** Check the native Drizzle journal in application order before a driver adopts or extends it. */
export function assertMigrationPrefix(
	rows: readonly { created_at: string | number | null; hash: string }[],
	artifact: DatabaseArtifact,
	instance: string,
): void {
	if (artifact.evolution === 'reset-on-schema-change') {
		// The schema snapshot determines the lineage, including when Kit changes SQL formatting.
		if (rows.length > 0 && (rows.length !== 1 || String(rows[0]!.created_at) !== '0')) {
			throw new Error(`[database] invalid reset baseline journal for ${instance}`)
		}
		return
	}
	for (const [index, row] of rows.entries()) {
		const migration = artifact.migrations[index]
		if (
			!migration ||
			String(row.created_at) !== String(migration.folderMillis) ||
			row.hash !== migration.hash
		) {
			throw new Error(
				`[database] Drizzle history is not an immutable prefix of lineage "${artifact.lineage}" for ${instance} at entry ${index} (timestamp ${row.created_at})`,
			)
		}
	}
}
