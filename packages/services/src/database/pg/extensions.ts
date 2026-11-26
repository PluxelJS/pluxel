import { sql } from 'drizzle-orm'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'
import { SYSTEM_SCHEMA } from './system'

const EXTENSIONS_SCHEMA = 'pluxel_extensions'
type Transaction = PgTransaction<PgQueryResultHKT>

/** PostgreSQL installs an extension once per database, including when many owners require it. */
export async function resolveExtensionSchemas(
	tx: Transaction,
	required: readonly string[],
	ownerSchema: string | undefined,
): Promise<string[]> {
	if (required.length === 0) return []
	const names = [...new Set(required)]
	const readInstalled = () =>
		tx._.session.all<{ name: string; schema: string; managed: boolean }>(sql`
		SELECT e.extname AS name, n.nspname AS schema,
			EXISTS (SELECT 1 FROM ${sql.identifier(SYSTEM_SCHEMA)}.database_instances WHERE physical_schema = n.nspname) AS managed
		FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
		WHERE e.extname IN (${sql.join(
			names.map((name) => sql`${name}`),
			sql`, `,
		)})
		ORDER BY e.extname
	`)
	let installed = await readInstalled()
	if (installed.length < names.length) {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('pluxel/extensions', 0))`)
		await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(EXTENSIONS_SCHEMA)}`)
		await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(EXTENSIONS_SCHEMA)}, pg_catalog`)
		for (const name of names) {
			if (!installed.some((entry) => entry.name === name)) {
				await tx.execute(sql`CREATE EXTENSION IF NOT EXISTS ${sql.identifier(name)}`)
			}
		}
		installed = await readInstalled()
	}
	const schemas = new Set<string>()
	for (const entry of installed) {
		if (entry.schema === ownerSchema || entry.schema === 'pg_catalog') continue
		if (entry.managed || entry.schema === SYSTEM_SCHEMA) {
			throw new Error(
				`[pluxel/pg] extension "${entry.name}" is installed in private schema "${entry.schema}". Have the database administrator relocate it to a shared extension schema before using it for this owner.`,
			)
		}
		schemas.add(entry.schema)
	}
	return [...schemas]
}

export async function grantExtensionUsage(
	tx: Transaction,
	role: string,
	schemas: readonly string[],
): Promise<void> {
	if (schemas.length === 0) return
	const missingUsage = () =>
		tx._.session.all<{ name: string }>(sql`
		SELECT nspname AS name FROM pg_catalog.pg_namespace
		WHERE nspname IN (${sql.join(
			schemas.map((name) => sql`${name}`),
			sql`, `,
		)})
			AND NOT has_schema_privilege(${role}, oid, 'USAGE')
	`)
	const missing = await missingUsage()
	if (missing.length > 0) {
		await tx.execute(sql`GRANT USAGE ON SCHEMA
			${sql.join(
				missing.map(({ name }) => sql.identifier(name)),
				sql`, `,
			)} TO ${sql.identifier(role)}`)
		const [denied] = await missingUsage()
		if (denied)
			throw new Error(`[pluxel/pg] role "${role}" needs USAGE on extension schema "${denied.name}"`)
	}
}
