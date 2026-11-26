import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core/session'
import type { ExtractTablesWithRelations } from 'drizzle-orm/relations'
import {
	freezeDatabaseDefinition,
	databaseSchema,
	type DatabaseEvolution,
	type DatabaseSchema,
} from './database/artifact'

export type { DatabaseEvolution } from './database/artifact'

export type DatabaseRequirement = Readonly<{
	extensions?: readonly string[]
}>

export type DatabaseDefinition<TSchema extends Record<string, unknown> = Record<string, unknown>> =
	DatabaseSchema<'postgresql', TSchema> & Readonly<{ requirements: DatabaseRequirement }>

export type PluginDatabaseClient<Definition extends DatabaseDefinition> = PgDatabase<
	PgQueryResultHKT,
	Definition['schema']
>

export type PluginDatabaseTransaction<Definition extends DatabaseDefinition> = PgTransaction<
	PgQueryResultHKT,
	Definition['schema'],
	ExtractTablesWithRelations<Definition['schema']>
>

export interface PluginDatabaseHandle<Definition extends DatabaseDefinition = DatabaseDefinition> {
	/** Run a read-only transaction using the owner's schema. */
	read<Result>(
		callback: (db: PluginDatabaseClient<Definition>) => Result | Promise<Result>,
	): Promise<Result>
	/** Commit when the callback succeeds and roll back when it throws or rejects. */
	transaction<Result>(
		callback: (tx: PluginDatabaseTransaction<Definition>) => Result | Promise<Result>,
	): Promise<Result>
}

export function defineDatabase<const TSchema extends Record<string, unknown>>(input: {
	schema: TSchema
	requirements?: DatabaseRequirement
	evolution?: DatabaseEvolution
}): DatabaseDefinition<TSchema> {
	const schema = databaseSchema('postgresql', input)
	const { requirements = {} } = input
	if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
		throw new TypeError('[pluxel/pg] requirements must be an object')
	}
	const { extensions = [] } = requirements
	if (!Array.isArray(extensions)) {
		throw new TypeError('[pluxel/pg] requirements.extensions must be an array')
	}
	for (const extension of extensions) {
		if (typeof extension !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(extension)) {
			throw new TypeError(
				'[pluxel/pg] requirements.extensions contains an invalid PostgreSQL extension name',
			)
		}
	}
	return freezeDatabaseDefinition(
		{
			...schema,
			requirements: Object.freeze({
				extensions: Object.freeze([...extensions]),
			}),
		},
		arguments[1],
	)
}

/** PostgreSQL access scoped to the calling Plugin and its migration history. */
export abstract class Pg {
	static readonly access = 'owner' as const

	/** Prepare this Plugin's database and reuse its handle for subsequent calls with the same definition. */
	abstract use<Definition extends DatabaseDefinition>(
		definition: Definition,
	): Promise<PluginDatabaseHandle<Definition>>
}
