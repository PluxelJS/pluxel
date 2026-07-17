import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core/session'
import type { DatabaseArtifact, DatabaseEvolution } from './database-internal'

const databaseDefinitionMarker = Symbol.for('pluxel.database.definition')

export type DatabaseRequirement = Readonly<{
	extensions?: readonly string[]
}>

export type DatabaseDefinition<TSchema extends Record<string, unknown> = Record<string, unknown>> =
	Readonly<{
		schema: TSchema
		requirements: DatabaseRequirement
		evolution: DatabaseEvolution
	}>

type SchemaOf<Definition> =
	Definition extends DatabaseDefinition<infer Schema> ? Schema : Record<string, unknown>

export type PluginDatabaseClient<Definition extends DatabaseDefinition> = PgDatabase<
	PgQueryResultHKT,
	SchemaOf<Definition>
>

export type PluginDatabaseTransaction<Definition extends DatabaseDefinition> = PgTransaction<
	PgQueryResultHKT,
	SchemaOf<Definition>
>

export interface PluginDatabaseHandle<Definition extends DatabaseDefinition = DatabaseDefinition> {
	read<Result>(
		callback: (db: PluginDatabaseClient<Definition>) => Result | Promise<Result>,
	): Promise<Result>
	transaction<Result>(
		callback: (tx: PluginDatabaseTransaction<Definition>) => Result | Promise<Result>,
	): Promise<Result>
}

export function defineDatabase<const TSchema extends Record<string, unknown>>(input: {
	schema: TSchema
	requirements?: DatabaseRequirement
	evolution?: DatabaseEvolution
}): DatabaseDefinition<TSchema> {
	if (!input || typeof input !== 'object' || !input.schema || typeof input.schema !== 'object') {
		throw new TypeError('[pluxel/database] defineDatabase() requires a schema object')
	}
	const evolution = input.evolution ?? 'migrations'
	if (evolution !== 'migrations' && evolution !== 'reset-on-schema-change') {
		throw new TypeError(`[pluxel/database] invalid database evolution strategy "${evolution}"`)
	}
	// The production compiler supplies this hidden argument after validating the checked-in
	// migration artifact. Keeping it out of the signature prevents it becoming author API.
	const artifact = (arguments[1] as DatabaseArtifact | undefined) ?? {
		evolution,
		lineage: 'development',
		migrations: [],
	}
	if (artifact.evolution !== evolution) {
		throw new TypeError(
			'[pluxel/database] database evolution artifact does not match its definition',
		)
	}
	const lineage = String(artifact.lineage ?? '').trim()
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(lineage)) {
		throw new TypeError('[pluxel/database] invalid database lineage artifact')
	}
	const migrations = artifact.migrations.map((migration, index) => {
		const id = String(migration.id ?? '').trim()
		const checksum = String(migration.checksum ?? '')
			.trim()
			.toLowerCase()
		const migrationSql = String(migration.sql ?? '').trim()
		if (!id || !checksum || !migrationSql) {
			throw new TypeError(`[pluxel/database] invalid migration artifact at index ${index}`)
		}
		return Object.freeze({ id, checksum, sql: migrationSql })
	})
	for (let index = 1; index < migrations.length; index += 1) {
		if (migrations[index - 1]!.id >= migrations[index]!.id) {
			throw new Error('[pluxel/database] migrations must have unique, ascending ids')
		}
	}
	const definition = {
		schema: Object.freeze({ ...input.schema }) as TSchema,
		evolution,
		requirements: Object.freeze({
			extensions: Object.freeze([...(input.requirements?.extensions ?? [])]),
		}),
	}
	Object.defineProperty(definition, databaseDefinitionMarker, {
		value: Object.freeze({
			evolution,
			lineage,
			migrations: Object.freeze(migrations),
		}),
	})
	return Object.freeze(definition)
}
