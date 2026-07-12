import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client/sqlite3'
import { drizzle } from 'drizzle-orm/libsql/sqlite3'
import { gatewaySchema } from './schema.ts'

const DB_FILE = 'external-api-gateway.sqlite'
const SCHEMA_VERSION = '2026_07_09_006'

export type ExternalGatewayDatabase = ReturnType<typeof drizzle<typeof gatewaySchema>>

export type ExternalGatewayDbHandle = {
	client: Client
	db: ExternalGatewayDatabase
	file: string
}

type DbContext = {
	config: {
		persistence?: unknown
	}
	effects: {
		defer(callback: () => void): void
	}
}

export async function useExternalGatewayDB(ctx: DbContext): Promise<ExternalGatewayDbHandle> {
	if (typeof ctx.config.persistence !== 'string') {
		throw new TypeError(
			'ExternalGateway database requires file persistence: set persistence to a root path.',
		)
	}
	const baseDir = resolve(ctx.config.persistence, 'plugin-data')
	const file = resolve(baseDir, DB_FILE)
	await mkdir(dirname(file), { recursive: true })

	const client = createClient({
		url: pathToFileURL(file).href,
		timeout: 5_000,
		intMode: 'number',
	})
	ctx.effects.defer(() => {
		if (!client.closed) client.close()
	})

	await client.execute('SELECT 1')
	await client.execute('PRAGMA foreign_keys = ON')
	await migrate(client)

	return {
		client,
		db: drizzle(client, { schema: gatewaySchema }),
		file,
	}
}

async function migrate(client: Client): Promise<void> {
	const tableCount = await userTableCount(client)
	const actual = await readSchemaVersion(client)
	if (tableCount > 0 && actual !== SCHEMA_VERSION) await resetDatabase(client)
	await createSchema(client)
	await client.execute({
		sql: `
			INSERT INTO gateway_meta (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`,
		args: ['schema_version', SCHEMA_VERSION],
	})
}

async function createSchema(client: Client): Promise<void> {
	await client.executeMultiple(`
		CREATE TABLE IF NOT EXISTS gateway_meta (
			key TEXT PRIMARY KEY NOT NULL,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS gateway_tokens (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL,
			token_hash TEXT NOT NULL,
			token_preview TEXT NOT NULL,
			enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_used_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS billing_usage_records (
			id TEXT PRIMARY KEY NOT NULL,
			at INTEGER NOT NULL,
			user_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			plugin_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			model TEXT,
			ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
			status TEXT NOT NULL,
			latency_ms INTEGER NOT NULL,
			input_bytes INTEGER NOT NULL,
			output_bytes INTEGER NOT NULL,
			units REAL NOT NULL,
			unit_name TEXT NOT NULL,
			cost_cny REAL NOT NULL,
			currency TEXT NOT NULL,
			cost_estimated INTEGER NOT NULL CHECK (cost_estimated IN (0, 1)),
			upstream_request_id TEXT,
			metadata_json TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_billing_usage_records_at
			ON billing_usage_records (at);
		CREATE INDEX IF NOT EXISTS idx_billing_usage_records_provider_operation_at
			ON billing_usage_records (provider, operation, at);
		CREATE INDEX IF NOT EXISTS idx_billing_usage_records_user_at
			ON billing_usage_records (user_id, at);

		CREATE TABLE IF NOT EXISTS billing_rates (
			id TEXT PRIMARY KEY NOT NULL,
			provider TEXT NOT NULL,
			operation TEXT NOT NULL,
			model TEXT,
			unit_name TEXT NOT NULL,
			unit_cost_cny REAL NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS provider_call_history (
			id TEXT PRIMARY KEY NOT NULL,
			provider TEXT NOT NULL,
			provider_record_id TEXT NOT NULL,
			at INTEGER NOT NULL,
			source TEXT NOT NULL CHECK (source IN ('ui', 'rpc', 'settings')),
			user_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			model TEXT,
			ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
			status TEXT NOT NULL,
			latency_ms INTEGER NOT NULL,
			input_bytes INTEGER NOT NULL,
			output_bytes INTEGER NOT NULL,
			upstream_request_id TEXT,
			request_preview TEXT,
			response_preview TEXT,
			error TEXT,
			details_json TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_provider_call_history_provider_at
			ON provider_call_history (provider, at);
		CREATE INDEX IF NOT EXISTS idx_provider_call_history_provider_record
			ON provider_call_history (provider, provider_record_id);

		CREATE TABLE IF NOT EXISTS yiqicha_response_cache (
			id TEXT PRIMARY KEY NOT NULL,
			api_code TEXT NOT NULL,
			api_key TEXT NOT NULL,
			params_json TEXT NOT NULL,
			status TEXT NOT NULL,
			http_status INTEGER NOT NULL,
			content_type TEXT NOT NULL,
			body_text TEXT NOT NULL,
			output_bytes INTEGER NOT NULL,
			upstream_request_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_hit_at INTEGER,
			hit_count INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_yiqicha_response_cache_api_code
			ON yiqicha_response_cache (api_code);
		CREATE INDEX IF NOT EXISTS idx_yiqicha_response_cache_last_hit_at
			ON yiqicha_response_cache (last_hit_at);
		CREATE INDEX IF NOT EXISTS idx_yiqicha_response_cache_updated_at
			ON yiqicha_response_cache (updated_at);
	`)
}

async function readSchemaVersion(client: Client): Promise<string | undefined> {
	const metaExists = await client.execute({
		sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gateway_meta'",
	})
	if (metaExists.rows.length === 0) return undefined
	const result = await client.execute({
		sql: 'SELECT value FROM gateway_meta WHERE key = ?',
		args: ['schema_version'],
	})
	const value = result.rows[0]?.value
	return value === undefined ? undefined : String(value)
}

async function userTableCount(client: Client): Promise<number> {
	const result = await client.execute(`
		SELECT COUNT(*) AS count
		FROM sqlite_master
		WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
	`)
	return Number(result.rows[0]?.count ?? 0)
}

async function resetDatabase(client: Client): Promise<void> {
	const result = await client.execute(`
		SELECT name
		FROM sqlite_master
		WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
	`)
	for (const row of result.rows) {
		const name = String(row.name)
		await client.execute(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(name)}`)
	}
}

function quoteSqliteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}
