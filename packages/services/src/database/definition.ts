import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core/session'
import type { DatabaseArtifact } from './artifact'

const databaseDefinitionMarker = Symbol.for('pluxel.database.definition')

export type DatabaseRequirement = Readonly<{
	extensions?: readonly string[]
}>

/** Schema evolution strategy used by a Plugin-owned database. */
export type DatabaseEvolution = 'migrations' | 'reset-on-schema-change'

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
	if (!input?.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) {
		throw new TypeError('[pluxel/pg] defineDatabase() requires a schema object')
	}
	const { evolution = 'migrations', requirements = {} } = input
	if (evolution !== 'migrations' && evolution !== 'reset-on-schema-change') {
		throw new TypeError(`[pluxel/pg] invalid database evolution strategy "${evolution}"`)
	}
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
	// The production compiler supplies this hidden argument after validating the checked-in
	// migration artifact. Keeping it out of the signature prevents it becoming author API.
	const artifact = (arguments[1] as DatabaseArtifact | undefined) ?? {
		evolution,
		lineage: 'development',
		migrations: [],
	}
	if (artifact.evolution !== evolution) {
		throw new TypeError('[pluxel/pg] database evolution artifact does not match its definition')
	}
	const lineage = String(artifact.lineage ?? '').trim()
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(lineage)) {
		throw new TypeError('[pluxel/pg] invalid database lineage artifact')
	}
	const migrations = artifact.migrations.map((migration, index) => {
		const id = String(migration.id ?? '').trim()
		const checksum = String(migration.checksum ?? '')
			.trim()
			.toLowerCase()
		const migrationSql = String(migration.sql ?? '').trim()
		if (!id || !checksum || !migrationSql) {
			throw new TypeError(`[pluxel/pg] invalid migration artifact at index ${index}`)
		}
		return Object.freeze({ id, checksum, sql: migrationSql })
	})
	for (let index = 1; index < migrations.length; index += 1) {
		if (migrations[index - 1]!.id >= migrations[index]!.id) {
			throw new Error('[pluxel/pg] migrations must have unique, ascending ids')
		}
	}
	const definition = {
		schema: Object.freeze({ ...input.schema }) as TSchema,
		evolution,
		requirements: Object.freeze({
			extensions: Object.freeze([...extensions]),
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
