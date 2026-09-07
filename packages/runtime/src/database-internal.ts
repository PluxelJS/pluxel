import type { DatabaseDefinition, DatabaseEvolution } from './database'

const databaseDefinitionMarker = Symbol.for('pluxel.database.definition')

export type DatabaseMigration = Readonly<{
	id: string
	checksum: string
	sql: string
}>

export type DatabaseArtifact = Readonly<{
	evolution: DatabaseEvolution
	lineage: string
	migrations: readonly DatabaseMigration[]
}>

export function readDatabaseDefinition(definition: DatabaseDefinition): DatabaseArtifact {
	const artifact = (definition as unknown as Record<symbol, DatabaseArtifact> | undefined)?.[
		databaseDefinitionMarker
	]
	if (!artifact) throw new TypeError('[pluxel/database] invalid database definition')
	return artifact
}
