import {
	freezeDatabaseDefinition,
	databaseSchema,
	type DatabaseEvolution,
	type DatabaseSchema,
} from './database/artifact'
import type { PluginDatabaseHandle } from './database/sqlite/handle'

export type { DatabaseEvolution } from './database/artifact'
export type { PluginDatabaseHandle } from './database/sqlite/handle'

export type DatabaseDefinition<Schema extends Record<string, unknown> = Record<string, unknown>> =
	DatabaseSchema<'sqlite', Schema>

export function defineDatabase<const Schema extends Record<string, unknown>>(input: {
	schema: Schema
	evolution?: DatabaseEvolution
}): DatabaseDefinition<Schema> {
	const definition = databaseSchema('sqlite', input)
	return freezeDatabaseDefinition(definition, arguments[1])
}

/** SQLite access scoped to the calling plugin. The Host installs the driver. */
export abstract class Sqlite {
	static readonly access = 'owner' as const

	abstract use<Definition extends DatabaseDefinition>(
		definition: Definition,
	): Promise<PluginDatabaseHandle<Definition>>
}
