import { sql } from 'drizzle-orm'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'

export const SYSTEM_SCHEMA = 'pluxel_system'
const schema = sql.identifier(SYSTEM_SCHEMA)

export async function prepareDatabaseSystem(tx: PgTransaction<PgQueryResultHKT>): Promise<void> {
	await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${schema}`)
	await tx.execute(sql`
		CREATE TABLE IF NOT EXISTS ${schema}.database_instances (
			instance_id text PRIMARY KEY,
			owner_id text NOT NULL,
			lineage text NOT NULL,
			physical_schema text NOT NULL UNIQUE,
			physical_role text NOT NULL UNIQUE,
			artifact_fingerprint text NOT NULL,
			runtime_version integer NOT NULL,
			state text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			activated_at timestamptz,
			archived_at timestamptz
		)`)
	await tx.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS database_instances_active_owner
		ON ${schema}.database_instances(owner_id) WHERE state = 'active'`)
	await tx.execute(sql`
		CREATE TABLE IF NOT EXISTS ${schema}.outbox_pending (
			id bigserial PRIMARY KEY,
			owner_schema text NOT NULL,
			table_name text NOT NULL,
			transaction_id text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now()
		)`)
	await tx.execute(sql`
		CREATE TABLE IF NOT EXISTS ${schema}.invalidation_log (
			id bigserial PRIMARY KEY,
			owner_schema text NOT NULL,
			table_name text NOT NULL,
			published_at timestamptz NOT NULL DEFAULT now()
		)`)
	await tx.execute(sql`
		CREATE OR REPLACE FUNCTION ${schema}.capture_change() RETURNS trigger AS $$
		BEGIN
			INSERT INTO ${schema}.outbox_pending(owner_schema, table_name, transaction_id)
			VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, current_setting('pluxel.transaction_id', true));
			RETURN NULL;
		END;
		$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog`)
}
