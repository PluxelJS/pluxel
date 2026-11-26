import { createHash } from 'node:crypto'
import type { DatabaseArtifact } from './artifact'

/** Check the delivered SQL bytes before a Node driver applies the compiled migration. */
export function validateMigrationArtifact(artifact: DatabaseArtifact): void {
	for (const migration of artifact.migrations) {
		const checksum = createHash('sha256')
			.update(migration.sql.join('--> statement-breakpoint'))
			.digest('hex')
		if (checksum !== migration.hash) {
			throw new Error(
				`[database] migration artifact checksum is invalid: ${artifact.lineage}/${migration.folderMillis}`,
			)
		}
	}
}
