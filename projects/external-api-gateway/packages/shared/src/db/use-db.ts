import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client/sqlite3'
import { drizzle } from 'drizzle-orm/libsql/sqlite3'
import { gatewaySchema } from './schema.ts'

const DB_FILE = 'external-api-gateway.sqlite'
const SCHEMA_VERSION = '2026_07_08_004'
const PREVIOUS_SCHEMA_VERSIONS = new Set(['2026_07_07_001', '2026_07_07_002', '2026_07_08_003'])

export type ExternalGatewayDatabase = ReturnType<typeof drizzle<typeof gatewaySchema>>

export type ExternalGatewayDbHandle = {
	client: Client
	db: ExternalGatewayDatabase
	file: string
}

type DbContext = {
	config: {
		pluginData?: {
			dir?: string
		}
	}
	effects: {
		defer(callback: () => void): void
	}
}

export async function useExternalGatewayDB(ctx: DbContext): Promise<ExternalGatewayDbHandle> {
	const baseDir = ctx.config.pluginData?.dir ?? '.pluxel/plugin-data'
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

		CREATE TABLE IF NOT EXISTS billing_rates (
			id TEXT PRIMARY KEY NOT NULL,
			provider TEXT NOT NULL,
			operation TEXT NOT NULL,
			model TEXT,
			unit_name TEXT NOT NULL,
			unit_cost_cny REAL NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS zhipu_test_runs (
			id TEXT PRIMARY KEY NOT NULL,
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
			file_name TEXT,
			upstream_request_id TEXT,
			request_preview TEXT,
			response_preview TEXT,
			error TEXT
		);

		CREATE TABLE IF NOT EXISTS yiqicha_test_runs (
			id TEXT PRIMARY KEY NOT NULL,
			at INTEGER NOT NULL,
			source TEXT NOT NULL CHECK (source IN ('ui', 'rpc', 'settings')),
			user_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			api_code TEXT,
			api_name TEXT,
			ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
			status TEXT NOT NULL,
			latency_ms INTEGER NOT NULL,
			input_bytes INTEGER NOT NULL,
			output_bytes INTEGER NOT NULL,
			upstream_request_id TEXT,
			request_preview TEXT,
			response_preview TEXT,
			error TEXT
		);
	`)

	const result = await client.execute({
		sql: 'SELECT value FROM gateway_meta WHERE key = ?',
		args: ['schema_version'],
	})
	const actual = result.rows[0]?.value
	if (actual === undefined) {
		await client.execute({
			sql: 'INSERT INTO gateway_meta (key, value) VALUES (?, ?)',
			args: ['schema_version', SCHEMA_VERSION],
		})
		return
	}
	if (PREVIOUS_SCHEMA_VERSIONS.has(String(actual))) {
		await client.execute({
			sql: 'UPDATE gateway_meta SET value = ? WHERE key = ?',
			args: [SCHEMA_VERSION, 'schema_version'],
		})
		return
	}
	if (actual !== SCHEMA_VERSION) {
		throw new Error(
			`external-api-gateway SQLite schema version mismatch: expected ${SCHEMA_VERSION}, got ${String(actual)}. Run the matching manual migration before starting the host.`,
		)
	}
}
