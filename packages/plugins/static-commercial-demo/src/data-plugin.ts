import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client/sqlite3'
import { BasePlugin, Plugin } from '@pluxel/runtime/authoring'
import { drizzle } from 'drizzle-orm/libsql/sqlite3'
import {
	commercialSchema,
	customers,
	orders,
	seedCustomers,
	seedOrders,
} from './db.ts'
import { CommercialDataStartupError } from './errors.ts'
import {
	createCommercialServices,
	type CommercialDatabase,
	type CommercialServices,
} from './services.ts'

const pluginName = 'CommercialDataPlugin'
const schemaVersion = '2026_06_24_001'

export class CommercialDataPlugin extends BasePlugin {
	private client: Client | null = null
	private database: CommercialDatabase | null = null
	private commercialServices: CommercialServices | null = null
	private databaseFile: string | null = null

	get services(): CommercialServices {
		if (!this.commercialServices) {
			throw new Error('CommercialDataPlugin is not running')
		}
		return this.commercialServices
	}

	override async init(signal: AbortSignal): Promise<void> {
		this.databaseFile = this.resolveDatabaseFile()
		await mkdir(dirname(this.databaseFile), { recursive: true })

		const client = createClient({
			url: pathToFileURL(this.databaseFile).href,
			timeout: 5_000,
			intMode: 'number',
		})
		this.client = client
		this.ctx.effects.defer(() => this.closeClient())

		try {
			if (signal.aborted) throw signal.reason

			await client.execute('SELECT 1')
			await client.execute('PRAGMA foreign_keys = ON')

			this.database = drizzle(client, { schema: commercialSchema })
			await this.installSchema(client)
			await this.assertSchemaVersion(client)
			await this.seedIfEmpty()

			this.commercialServices = createCommercialServices(this.database)

			this.ctx.logger.info('Commercial libSQL data plugin ready', {
				file: this.databaseFile,
				customers: await this.services.customerCount(),
				schemaVersion,
			})
		} catch (error) {
			this.closeClient()
			throw new CommercialDataStartupError(
				`CommercialDataPlugin failed to start with libSQL database ${this.databaseFile}. Check database permissions and schema version ${schemaVersion}.`,
				error,
			)
		}
	}

	override async stop(): Promise<void> {
		this.closeClient()
	}

	private resolveDatabaseFile(): string {
		const baseDir = this.ctx.config.pluginData?.dir ?? '.pluxel/plugin-data'
		return resolve(baseDir, pluginName, 'commercial.db')
	}

	private async installSchema(client: Client): Promise<void> {
		await client.executeMultiple(`
			CREATE TABLE IF NOT EXISTS pluxel_commercial_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS customers (
				id TEXT PRIMARY KEY NOT NULL,
				name TEXT NOT NULL,
				owner TEXT NOT NULL,
				tier TEXT NOT NULL CHECK (tier IN ('enterprise', 'growth', 'startup')),
				region TEXT NOT NULL,
				health_score INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS orders (
				id TEXT PRIMARY KEY NOT NULL,
				customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
				sku TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'approved', 'fulfilled')),
				amount INTEGER NOT NULL CHECK (amount > 0),
				margin REAL NOT NULL CHECK (margin >= 0 AND margin <= 1)
			);
		`)
	}

	private async assertSchemaVersion(client: Client): Promise<void> {
		const result = await client.execute({
			sql: 'SELECT value FROM pluxel_commercial_meta WHERE key = ?',
			args: ['schema_version'],
		})
		const actual = result.rows[0]?.value

		if (actual === undefined) {
			await client.execute({
				sql: 'INSERT INTO pluxel_commercial_meta (key, value) VALUES (?, ?)',
				args: ['schema_version', schemaVersion],
			})
			return
		}

		if (actual !== schemaVersion) {
			throw new Error(
				`CommercialDataPlugin schema version mismatch: expected ${schemaVersion}, got ${String(actual)}. Reset the demo database or run the matching migration before starting the host.`,
			)
		}
	}

	private async seedIfEmpty(): Promise<void> {
		if (!this.database) throw new Error('Commercial database is not ready')

		if (await this.hasSeedData()) return

		await this.database.batch([
			this.database.insert(customers).values([...seedCustomers]),
			this.database.insert(orders).values([...seedOrders]),
		])
	}

	private async hasSeedData(): Promise<boolean> {
		if (!this.database) return false
		const row = await this.database.select({ id: customers.id }).from(customers).limit(1).get()
		return Boolean(row)
	}

	private closeClient(): void {
		this.commercialServices = null
		this.database = null
		if (!this.client) return
		if (!this.client.closed) this.client.close()
		this.client = null
	}
}

Plugin({ name: pluginName })(CommercialDataPlugin)
