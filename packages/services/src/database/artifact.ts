import type { MigrationMeta } from 'drizzle-orm/migrator'

export type DatabaseEvolution = 'migrations' | 'reset-on-schema-change'
export type DatabaseDialect = 'postgresql' | 'sqlite'
export type DatabaseSchema<
	Dialect extends DatabaseDialect = DatabaseDialect,
	Schema extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{ dialect: Dialect; schema: Schema; evolution: DatabaseEvolution }>

const databaseDefinitionMarker = Symbol.for('pluxel.database.definition')
// Drizzle brands table instances with global symbols across module copies. Reading
// those brands keeps a Host that only installs a service from loading the ORM.
const drizzleTable = Symbol.for('drizzle:IsDrizzleTable')
const dialectTable = {
	postgresql: Symbol.for('drizzle:PgInlineForeignKeys'),
	sqlite: Symbol.for('drizzle:SQLiteInlineForeignKeys'),
}

export type DatabaseArtifact = Readonly<{
	evolution: DatabaseEvolution
	lineage: string
	migrations: readonly MigrationMeta[]
}>

export function databaseSchema<D extends DatabaseDialect, Schema extends Record<string, unknown>>(
	dialect: D,
	input: { schema: Schema; evolution?: DatabaseEvolution },
) {
	if (!input?.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) {
		throw new TypeError('[database] defineDatabase() requires a schema object')
	}
	const { evolution = 'migrations' } = input
	if (evolution !== 'migrations' && evolution !== 'reset-on-schema-change') {
		throw new TypeError(`[database] invalid database evolution strategy "${evolution}"`)
	}
	for (const [name, value] of Object.entries(input.schema)) {
		if (
			value &&
			typeof value === 'object' &&
			drizzleTable in value &&
			!(dialectTable[dialect] in value)
		) {
			throw new TypeError(`[database] table "${name}" does not use the ${dialect} dialect`)
		}
	}
	return { dialect, schema: Object.freeze({ ...input.schema }) as Schema, evolution }
}

export function freezeDatabaseDefinition<Definition extends DatabaseSchema>(
	definition: Definition,
	artifact: DatabaseArtifact | undefined,
): Readonly<Definition> {
	// Drizzle Kit evaluates the author module before a migration bundle exists.
	if (artifact === undefined) return Object.freeze(definition)
	if (!artifact || artifact.evolution !== definition.evolution) {
		throw new TypeError('[database] database evolution artifact does not match its definition')
	}
	const { lineage } = artifact
	if (typeof lineage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(lineage)) {
		throw new TypeError('[database] invalid database lineage artifact')
	}
	if (!Array.isArray(artifact.migrations) || artifact.migrations.length === 0) {
		throw new TypeError(
			`[database] the ${definition.dialect} artifact requires a nonempty Drizzle migration history; generate a migration and rebuild the plugin`,
		)
	}
	const migrations = artifact.migrations.map((migration: MigrationMeta, index) => {
		if (
			!migration ||
			!Number.isSafeInteger(migration.folderMillis) ||
			migration.folderMillis < 0 ||
			typeof migration.hash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(migration.hash) ||
			typeof migration.bps !== 'boolean' ||
			!Array.isArray(migration.sql) ||
			!migration.sql.every((statement) => typeof statement === 'string') ||
			!migration.sql.some((statement) => statement.trim())
		) {
			throw new TypeError(`[database] invalid Drizzle migration at index ${index}`)
		}
		if (index > 0 && migration.folderMillis <= artifact.migrations[index - 1]!.folderMillis) {
			throw new TypeError('[database] Drizzle migration timestamps must be strictly increasing')
		}
		const statements = [...migration.sql]
		Object.freeze(statements)
		return Object.freeze({
			sql: statements,
			folderMillis: migration.folderMillis,
			hash: migration.hash,
			bps: migration.bps,
		})
	})
	if (
		definition.evolution === 'reset-on-schema-change' &&
		(migrations.length !== 1 || migrations[0]!.folderMillis !== 0)
	) {
		throw new TypeError('[database] reset baseline must be one Drizzle migration at timestamp 0')
	}
	Object.defineProperty(definition, databaseDefinitionMarker, {
		value: Object.freeze({
			evolution: definition.evolution,
			lineage,
			migrations: Object.freeze(migrations),
		}),
	})
	return Object.freeze(definition)
}

export function readDatabaseDefinition(
	definition: DatabaseSchema,
	dialect: DatabaseDialect,
): DatabaseArtifact {
	const artifact = (definition as unknown as Record<symbol, DatabaseArtifact> | undefined)?.[
		databaseDefinitionMarker
	]
	if (!artifact || definition.dialect !== dialect) {
		throw new TypeError(
			`[database] expected a compiled ${dialect} database definition; build the plugin with the Pluxel toolchain`,
		)
	}
	return artifact
}
