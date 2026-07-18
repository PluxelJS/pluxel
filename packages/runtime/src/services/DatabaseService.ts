import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Injectable, type Context as CoreContext } from '@pluxel/core'
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable, type PgDatabase } from 'drizzle-orm/pg-core'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core/session'
import {
	readDatabaseDefinition,
	type DatabaseArtifact,
	type DatabaseMigration,
} from '../database-internal'
import type { DatabaseDefinition, PluginDatabaseHandle } from '../database'

const serviceName = 'database' as const
const SYSTEM_SCHEMA = 'pluxel_system'

export type DatabaseConfig =
	| false
	| Readonly<{ driver: 'pglite'; dataDir?: string }>
	| Readonly<{
			driver: 'postgres'
			connectionString: string
			pool?: Readonly<{
				max?: number
				idleTimeoutMs?: number
				connectionTimeoutMs?: number
			}>
			tls?: 'require' | 'verify-full'
	  }>

type AnyDatabase = PgDatabase<PgQueryResultHKT, any>

type DatabaseAdapter = {
	driver: 'pglite' | 'postgres'
	db: AnyDatabase
	concurrency: number
	close(): Promise<void>
}

type QueueItem<T = unknown> = {
	owner: string
	token: object
	run: () => Promise<T>
	resolve(value: T): void
	reject(error: unknown): void
	timer?: ReturnType<typeof setTimeout>
}

class FairScheduler {
	private readonly queues = new Map<string, QueueItem[]>()
	private readonly ownerOrder: string[] = []
	private running = 0
	private cursor = 0

	constructor(
		private readonly concurrency: number,
		private readonly pendingLimit = 100,
		private readonly timeoutMs = 30_000,
	) {}

	run<T>(owner: string, token: object, operation: () => Promise<T>): Promise<T> {
		let queue = this.queues.get(owner)
		if (!queue) {
			queue = []
			this.queues.set(owner, queue)
			this.ownerOrder.push(owner)
		}
		if (queue.length >= this.pendingLimit) {
			return Promise.reject(
				new Error(`[pluxel/database] pending operation limit exceeded for plugin "${owner}"`),
			)
		}
		return new Promise<T>((resolve, reject) => {
			let item!: QueueItem<T>
			const timer = setTimeout(() => {
				if (!this.remove(item)) return
				reject(
					new Error(`[pluxel/database] operation timed out while queued for plugin "${owner}"`),
				)
			}, this.timeoutMs)
			item = { owner, token, run: operation, resolve, reject, timer }
			queue!.push(item as QueueItem)
			this.flush()
		})
	}

	cancel(token: object): void {
		for (const queue of this.queues.values()) {
			for (let index = queue.length - 1; index >= 0; index -= 1) {
				const item = queue[index]!
				if (item.token !== token || !this.remove(item)) continue
				item.reject(new Error('[pluxel/database] database owner stopped before operation started'))
			}
		}
	}

	private remove(item: QueueItem): boolean {
		const queue = this.queues.get(item.owner)
		const index = queue?.indexOf(item) ?? -1
		if (!queue || index < 0) return false
		queue.splice(index, 1)
		if (item.timer) clearTimeout(item.timer)
		return true
	}

	private flush(): void {
		while (this.running < this.concurrency) {
			const item = this.next()
			if (!item) return
			if (item.timer) clearTimeout(item.timer)
			this.running++
			void item
				.run()
				.then(item.resolve, item.reject)
				.finally(() => {
					this.running--
					this.flush()
				})
		}
	}

	private next(): QueueItem | undefined {
		if (this.ownerOrder.length === 0) return undefined
		for (let visited = 0; visited < this.ownerOrder.length; visited += 1) {
			this.cursor %= this.ownerOrder.length
			const owner = this.ownerOrder[this.cursor]!
			this.cursor = (this.cursor + 1) % this.ownerOrder.length
			const item = this.queues.get(owner)?.shift()
			if (item) return item
		}
		return undefined
	}
}

type Invalidation = Readonly<{ ownerSchema: string; table: string; revision: number }>
type InvalidationListener = (event: Invalidation) => void

const DATABASE_INSTANCE_RUNTIME_VERSION = 1

type PreparedDatabaseInstance = Readonly<{
	instanceId: string
	ownerId: string
	lineage: string
	ownerSchema: string
	ownerRole: string
	artifactFingerprint: string
	runtimeVersion: number
}>

class DatabaseCoordinator {
	private adapterTask?: Promise<DatabaseAdapter>
	private schedulerTask?: Promise<FairScheduler>
	private systemReady?: Promise<void>
	private readonly preparing = new Map<string, Promise<PreparedDatabaseInstance>>()
	private readonly activeInstances = new Map<string, PreparedDatabaseInstance>()
	private readonly listeners = new Set<InvalidationListener>()
	private pollTimer?: ReturnType<typeof setInterval>
	private dispatchTask?: Promise<void>
	private checkpoint = 0
	private disposed = false

	constructor(private readonly root: CoreContext) {
		root.effects.defer(() => this.dispose(), { tag: 'DatabaseCoordinator' })
	}

	async acquire<Definition extends DatabaseDefinition>(
		owner: CoreContext,
		definition: Definition,
	): Promise<PluginDatabaseHandle<Definition>> {
		if (this.root.config.database === false) {
			throw new Error(
				`[pluxel/database] database capability is disabled for plugin "${owner.pluginInfo.id}"`,
			)
		}
		const artifact = readDatabaseDefinition(definition)
		const ownerId = String(owner.pluginInfo.id ?? '').trim()
		if (!ownerId) throw new Error('[pluxel/database] database use requires a plugin Context')
		const instance = await this.prepare(ownerId, definition, artifact)
		return new OwnerDatabaseHandle(this, owner, definition, instance)
	}

	async operation<T>(
		ownerId: string,
		token: object,
		instance: PreparedDatabaseInstance,
		readonly: boolean,
		callback: (database: AnyDatabase) => T | Promise<T>,
	): Promise<T> {
		if (this.disposed) throw new Error('[pluxel/database] database coordinator is stopped')
		const scheduler = await this.scheduler()
		return await scheduler.run(ownerId, token, async () => {
			const adapter = await this.adapter()
			let changed = false
			const result = await adapter.db.transaction(async (tx: AnyDatabase) => {
				if (readonly) await tx.execute(sql.raw('SET TRANSACTION READ ONLY'))
				if (adapter.driver === 'postgres') {
					await lockDatabaseOwner(tx, ownerId, 'shared')
					await assertActiveInstance(tx, instance)
				} else if (this.activeInstances.get(ownerId)?.instanceId !== instance.instanceId) {
					throw new Error('[pluxel/database] database handle instance has been replaced')
				}
				await tx.execute(sql.raw(`SET LOCAL ROLE ${quoteIdent(instance.ownerRole)}`))
				await tx.execute(
					sql.raw(`SET LOCAL search_path TO ${quoteIdent(instance.ownerSchema)}, pg_catalog`),
				)
				await tx.execute(sql.raw(`SET LOCAL statement_timeout TO '30000ms'`))
				await tx.execute(sql.raw(`SET LOCAL lock_timeout TO '5000ms'`))
				await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout TO '30000ms'`))
				if (!readonly) {
					await tx.execute(
						sql.raw(
							`SELECT set_config('pluxel.transaction_id', ${quoteLiteral(randomUUID())}, true)`,
						),
					)
					changed = true
				}
				return await callback(tx)
			})
			if (changed) this.requestDispatch()
			return result as T
		})
	}

	cancel(token: object): void {
		void this.schedulerTask?.then((scheduler) => scheduler.cancel(token))
	}

	subscribe(ownerSchema: string, tables: ReadonlySet<string>, listener: () => void): () => void {
		const wrapped: InvalidationListener = (event) => {
			if (event.ownerSchema === ownerSchema && tables.has(event.table)) listener()
		}
		this.listeners.add(wrapped)
		if (!this.pollTimer) {
			this.pollTimer = setInterval(() => {
				this.requestDispatch()
			}, 500)
		}
		return () => {
			this.listeners.delete(wrapped)
			if (this.listeners.size === 0 && this.pollTimer) {
				clearInterval(this.pollTimer)
				this.pollTimer = undefined
			}
		}
	}

	private async prepare(
		ownerId: string,
		definition: DatabaseDefinition,
		artifact: DatabaseArtifact,
	): Promise<PreparedDatabaseInstance> {
		const tables = schemaTableNames(definition)
		if (tables.length > 0 && artifact.migrations.length === 0) {
			throw new Error(
				artifact.evolution === 'reset-on-schema-change'
					? '[pluxel/database] reset database baseline is missing; build the plugin with the Pluxel toolchain'
					: '[pluxel/database] database migration artifact is missing; run `pluxel database generate` and build the plugin with the Pluxel toolchain',
			)
		}
		validateMigrationArtifact(artifact)
		const fingerprint = databaseArtifactFingerprint(definition, artifact, tables)
		await this.ensureSystem()
		const adapter = await this.adapter()
		const cached = this.activeInstances.get(ownerId)
		if (
			adapter.driver === 'pglite' &&
			cached &&
			instanceMatches(cached, artifact.lineage, fingerprint)
		) {
			return cached
		}

		const key = `${ownerId}\0${fingerprint}`
		let task = this.preparing.get(key)
		if (!task) {
			task = this.prepareOwner(ownerId, definition, artifact, fingerprint, tables)
			this.preparing.set(key, task)
		}
		try {
			return await task
		} finally {
			if (this.preparing.get(key) === task) this.preparing.delete(key)
		}
	}

	private async prepareOwner(
		ownerId: string,
		definition: DatabaseDefinition,
		artifact: DatabaseArtifact,
		fingerprint: string,
		tables: readonly string[],
	): Promise<PreparedDatabaseInstance> {
		const scheduler = await this.scheduler()
		const token = {}
		return await scheduler.run(`$prepare:${ownerId}`, token, async () => {
			const adapter = await this.adapter()
			const instance = await adapter.db.transaction(async (tx: AnyDatabase) => {
				if (adapter.driver === 'postgres') await lockDatabaseOwner(tx, ownerId, 'exclusive')
				await tx.execute(
					sql.raw(
						`SELECT set_config('pluxel.transaction_id', ${quoteLiteral(randomUUID())}, true)`,
					),
				)
				let active = await readActiveInstance(tx, ownerId)
				if (active && instanceMatches(active, artifact.lineage, fingerprint)) return active
				if (!active) active = await this.adoptLegacyInstance(tx, ownerId)
				if (active?.lineage === artifact.lineage) {
					return await this.upgradeInstance(tx, active, definition, artifact, fingerprint, tables)
				}
				return await this.createInstance(
					tx,
					ownerId,
					active,
					definition,
					artifact,
					fingerprint,
					tables,
				)
			})
			this.activeInstances.set(ownerId, instance)
			return instance
		})
	}

	private async upgradeInstance(
		tx: AnyDatabase,
		instance: PreparedDatabaseInstance,
		definition: DatabaseDefinition,
		artifact: DatabaseArtifact,
		fingerprint: string,
		tables: readonly string[],
	): Promise<PreparedDatabaseInstance> {
		const applied = await readAppliedMigrations(tx, instance.instanceId)
		if (artifact.evolution === 'migrations') {
			assertMigrationHistory(instance, artifact, applied)
		}
		await tx.execute(
			sql.raw(`SET LOCAL search_path TO ${quoteIdent(instance.ownerSchema)}, pg_catalog`),
		)
		await ensureExtensions(tx, definition)
		let changed = false
		if (artifact.evolution === 'migrations') {
			for (const migration of artifact.migrations) {
				if (applied.has(migration.id)) continue
				await this.applyMigration(tx, instance, migration)
				changed = true
			}
		}
		if (changed || instance.runtimeVersion !== DATABASE_INSTANCE_RUNTIME_VERSION) {
			await grantOwnerTables(tx, instance.ownerSchema, instance.ownerRole)
			for (const table of tables) await installOutboxTrigger(tx, instance.ownerSchema, table)
		}
		await tx.execute(
			sql.raw(
				`UPDATE ${SYSTEM_SCHEMA}.database_instances SET artifact_fingerprint = ${quoteLiteral(fingerprint)}, runtime_version = ${DATABASE_INSTANCE_RUNTIME_VERSION} WHERE instance_id = ${quoteLiteral(instance.instanceId)}`,
			),
		)
		return {
			...instance,
			artifactFingerprint: fingerprint,
			runtimeVersion: DATABASE_INSTANCE_RUNTIME_VERSION,
		}
	}

	private async createInstance(
		tx: AnyDatabase,
		ownerId: string,
		previous: PreparedDatabaseInstance | undefined,
		definition: DatabaseDefinition,
		artifact: DatabaseArtifact,
		fingerprint: string,
		tables: readonly string[],
	): Promise<PreparedDatabaseInstance> {
		const instanceId = randomUUID()
		const ownerSchema = physicalSchemaForInstance(ownerId, instanceId)
		const ownerRole = physicalRoleForArtifact(ownerSchema)
		await tx.execute(
			sql.raw(
				`INSERT INTO ${SYSTEM_SCHEMA}.database_instances (instance_id, owner_id, lineage, physical_schema, physical_role, artifact_fingerprint, runtime_version, state) VALUES (${quoteLiteral(instanceId)}, ${quoteLiteral(ownerId)}, ${quoteLiteral(artifact.lineage)}, ${quoteLiteral(ownerSchema)}, ${quoteLiteral(ownerRole)}, ${quoteLiteral(fingerprint)}, ${DATABASE_INSTANCE_RUNTIME_VERSION}, 'preparing')`,
			),
		)
		await ensureOwnerRole(tx, ownerRole)
		await tx.execute(sql.raw(`CREATE SCHEMA ${quoteIdent(ownerSchema)}`))
		await tx.execute(sql.raw(`REVOKE ALL ON SCHEMA ${quoteIdent(ownerSchema)} FROM PUBLIC`))
		await tx.execute(
			sql.raw(`GRANT USAGE ON SCHEMA ${quoteIdent(ownerSchema)} TO ${quoteIdent(ownerRole)}`),
		)
		await tx.execute(sql.raw(`SET LOCAL search_path TO ${quoteIdent(ownerSchema)}, pg_catalog`))
		await ensureExtensions(tx, definition)
		const instance: PreparedDatabaseInstance = {
			instanceId,
			ownerId,
			lineage: artifact.lineage,
			ownerSchema,
			ownerRole,
			artifactFingerprint: fingerprint,
			runtimeVersion: DATABASE_INSTANCE_RUNTIME_VERSION,
		}
		for (const migration of artifact.migrations) await this.applyMigration(tx, instance, migration)
		await grantOwnerTables(tx, ownerSchema, ownerRole)
		for (const table of tables) await installOutboxTrigger(tx, ownerSchema, table)
		if (previous) {
			await tx.execute(
				sql.raw(
					`UPDATE ${SYSTEM_SCHEMA}.database_instances SET state = 'archived', archived_at = now() WHERE instance_id = ${quoteLiteral(previous.instanceId)}`,
				),
			)
			await tx.execute(
				sql.raw(
					`REVOKE ALL ON SCHEMA ${quoteIdent(previous.ownerSchema)} FROM ${quoteIdent(previous.ownerRole)}`,
				),
			)
		}
		await tx.execute(
			sql.raw(
				`UPDATE ${SYSTEM_SCHEMA}.database_instances SET state = 'active', activated_at = now() WHERE instance_id = ${quoteLiteral(instanceId)}`,
			),
		)
		return instance
	}

	private async applyMigration(
		tx: AnyDatabase,
		instance: PreparedDatabaseInstance,
		migration: DatabaseMigration,
	): Promise<void> {
		await executeSqlStatements(tx, migration.sql.replaceAll('--> statement-breakpoint', '\n'))
		await tx.execute(
			sql.raw(
				`INSERT INTO ${SYSTEM_SCHEMA}.database_migrations (instance_id, migration_id, checksum) VALUES (${quoteLiteral(instance.instanceId)}, ${quoteLiteral(migration.id)}, ${quoteLiteral(migration.checksum)})`,
			),
		)
	}

	private async adoptLegacyInstance(
		tx: AnyDatabase,
		ownerId: string,
	): Promise<PreparedDatabaseInstance | undefined> {
		const lineage = 'main'
		const ownerSchema = legacyPhysicalSchemaFor(ownerId)
		if (!(await databaseSchemaExists(tx, ownerSchema))) return undefined
		const instanceId = randomUUID()
		const ownerRole = physicalRoleForArtifact(ownerSchema)
		await tx.execute(
			sql.raw(
				`INSERT INTO ${SYSTEM_SCHEMA}.database_instances (instance_id, owner_id, lineage, physical_schema, physical_role, artifact_fingerprint, runtime_version, state, activated_at) VALUES (${quoteLiteral(instanceId)}, ${quoteLiteral(ownerId)}, ${quoteLiteral(lineage)}, ${quoteLiteral(ownerSchema)}, ${quoteLiteral(ownerRole)}, '', 0, 'active', now())`,
			),
		)
		const legacyTable = await tx.execute(
			sql.raw(`SELECT to_regclass('${SYSTEM_SCHEMA}.plugin_migrations') AS name`),
		)
		if (resultRows(legacyTable)[0]?.name) {
			await tx.execute(
				sql.raw(
					`INSERT INTO ${SYSTEM_SCHEMA}.database_migrations (instance_id, migration_id, checksum, applied_at) SELECT ${quoteLiteral(instanceId)}, migration_id, checksum, applied_at FROM ${SYSTEM_SCHEMA}.plugin_migrations WHERE owner_schema = ${quoteLiteral(ownerSchema)} ON CONFLICT DO NOTHING`,
				),
			)
		}
		return {
			instanceId,
			ownerId,
			lineage,
			ownerSchema,
			ownerRole,
			artifactFingerprint: '',
			runtimeVersion: 0,
		}
	}

	private ensureSystem(): Promise<void> {
		this.systemReady ??= this.initializeSystem()
		return this.systemReady
	}

	private async initializeSystem(): Promise<void> {
		const adapter = await this.adapter()
		await executeSqlStatements(
			adapter.db,
			`
				CREATE SCHEMA IF NOT EXISTS ${SYSTEM_SCHEMA};
				CREATE TABLE IF NOT EXISTS ${SYSTEM_SCHEMA}.database_instances (
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
				);
				CREATE UNIQUE INDEX IF NOT EXISTS database_instances_active_owner
				ON ${SYSTEM_SCHEMA}.database_instances(owner_id) WHERE state = 'active';
				CREATE TABLE IF NOT EXISTS ${SYSTEM_SCHEMA}.database_migrations (
					instance_id text NOT NULL REFERENCES ${SYSTEM_SCHEMA}.database_instances(instance_id) ON DELETE CASCADE,
					migration_id text NOT NULL,
					checksum text NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (instance_id, migration_id)
				);
				CREATE TABLE IF NOT EXISTS ${SYSTEM_SCHEMA}.outbox_pending (
					id bigserial PRIMARY KEY,
					owner_schema text NOT NULL,
					table_name text NOT NULL,
					transaction_id text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now()
				);
				CREATE TABLE IF NOT EXISTS ${SYSTEM_SCHEMA}.invalidation_log (
					id bigserial PRIMARY KEY,
					owner_schema text NOT NULL,
					table_name text NOT NULL,
					published_at timestamptz NOT NULL DEFAULT now()
				);
				CREATE OR REPLACE FUNCTION ${SYSTEM_SCHEMA}.capture_change() RETURNS trigger AS $$
				BEGIN
					INSERT INTO ${SYSTEM_SCHEMA}.outbox_pending(owner_schema, table_name, transaction_id)
					VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, current_setting('pluxel.transaction_id', true));
					RETURN NULL;
				END;
				$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;
			`,
		)
		const instances = await adapter.db.execute(
			sql.raw(
				`SELECT instance_id, owner_id, lineage, physical_schema, physical_role, artifact_fingerprint, runtime_version FROM ${SYSTEM_SCHEMA}.database_instances WHERE state = 'active'`,
			),
		)
		for (const row of resultRows(instances)) {
			const instance = databaseInstanceFromRow(row)
			this.activeInstances.set(instance.ownerId, instance)
		}
		const result = await adapter.db.execute(
			sql.raw(`SELECT COALESCE(MAX(id), 0) AS id FROM ${SYSTEM_SCHEMA}.invalidation_log`),
		)
		this.checkpoint = Number(resultRows(result)[0]?.id ?? 0)
	}

	private async dispatchAndPoll(): Promise<void> {
		if (this.disposed) return
		await this.ensureSystem()
		const scheduler = await this.scheduler()
		await scheduler.run('$outbox', this, async () => {
			const adapter = await this.adapter()
			await adapter.db.transaction(async (tx: AnyDatabase) => {
				await tx.execute(
					sql.raw(`
						WITH claimed AS (
							SELECT id, owner_schema, table_name FROM ${SYSTEM_SCHEMA}.outbox_pending
							ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1000
						), published AS (
							INSERT INTO ${SYSTEM_SCHEMA}.invalidation_log(owner_schema, table_name)
							SELECT owner_schema, table_name FROM claimed GROUP BY owner_schema, table_name
						)
						DELETE FROM ${SYSTEM_SCHEMA}.outbox_pending WHERE id IN (SELECT id FROM claimed)
					`),
				)
			})
			const result = await adapter.db.execute(
				sql.raw(
					`SELECT id, owner_schema, table_name FROM ${SYSTEM_SCHEMA}.invalidation_log WHERE id > ${this.checkpoint} ORDER BY id LIMIT 1000`,
				),
			)
			for (const row of resultRows(result)) {
				const event = {
					ownerSchema: String(row.owner_schema),
					table: String(row.table_name),
					revision: Number(row.id),
				}
				this.checkpoint = Math.max(this.checkpoint, event.revision)
				for (const listener of this.listeners) listener(event)
			}
		})
	}

	private requestDispatch(): void {
		if (this.disposed || this.dispatchTask) return
		const task = this.dispatchAndPoll()
			.catch((error) => this.report(error))
			.finally(() => {
				if (this.dispatchTask === task) this.dispatchTask = undefined
			})
		this.dispatchTask = task
	}

	private adapter(): Promise<DatabaseAdapter> {
		this.adapterTask ??= createAdapter(this.root.config.database, this.root.config.persistence)
		return this.adapterTask
	}

	private scheduler(): Promise<FairScheduler> {
		this.schedulerTask ??= this.adapter().then((adapter) => new FairScheduler(adapter.concurrency))
		return this.schedulerTask
	}

	private async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		if (this.pollTimer) clearInterval(this.pollTimer)
		this.pollTimer = undefined
		this.listeners.clear()
		await this.dispatchTask
		await this.adapterTask?.then((adapter) => adapter.close())
	}

	private report(error: unknown): void {
		this.root.logger.error('database outbox dispatcher failed', { error })
	}
}

class OwnerDatabaseHandle<
	Definition extends DatabaseDefinition,
> implements PluginDatabaseHandle<Definition> {
	private readonly token = {}
	private active = true

	constructor(
		private readonly coordinator: DatabaseCoordinator,
		private readonly owner: CoreContext,
		private readonly definition: Definition,
		private readonly instance: PreparedDatabaseInstance,
	) {
		owner.effects.defer(() => this.dispose(), { tag: 'PluginDatabase' })
	}

	read<Result>(callback: (db: any) => Result | Promise<Result>): Promise<Result> {
		return this.run(true, callback)
	}

	transaction<Result>(callback: (tx: any) => Result | Promise<Result>): Promise<Result> {
		return this.run(false, callback)
	}

	subscribe(tables: ReadonlySet<string>, listener: () => void): () => void {
		this.assertActive()
		return this.coordinator.subscribe(this.instance.ownerSchema, tables, listener)
	}

	private run<Result>(
		readonly: boolean,
		callback: (database: AnyDatabase) => Result | Promise<Result>,
	): Promise<Result> {
		if (!this.active) {
			return Promise.reject(new Error('[pluxel/database] database handle owner has stopped'))
		}
		if (typeof callback !== 'function') {
			return Promise.reject(new TypeError('[pluxel/database] operation requires a callback'))
		}
		return this.coordinator.operation(
			String(this.owner.pluginInfo.id),
			this.token,
			this.instance,
			readonly,
			callback,
		)
	}

	private dispose(): void {
		if (!this.active) return
		this.active = false
		this.coordinator.cancel(this.token)
	}

	private assertActive(): void {
		if (!this.active) throw new Error('[pluxel/database] database handle owner has stopped')
	}
}

const coordinators = new WeakMap<CoreContext, DatabaseCoordinator>()

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			database?: DatabaseConfig
		}
		interface Services {
			[serviceName]: DatabaseService
		}
	}
}

@Injectable({ key: serviceName })
export class DatabaseService {
	private handle?: PluginDatabaseHandle
	private definition?: DatabaseDefinition

	constructor(
		public readonly ctx: CoreContext,
		_cfg: unknown,
	) {}

	async use<Definition extends DatabaseDefinition>(
		definition: Definition,
	): Promise<PluginDatabaseHandle<Definition>> {
		if (this.handle) {
			if (this.definition !== definition) {
				throw new Error('[pluxel/database] each plugin may use only one database definition')
			}
			return this.handle as PluginDatabaseHandle<Definition>
		}
		this.definition = definition
		try {
			this.handle = await coordinatorFor(this.ctx).acquire(this.ctx, definition)
			return this.handle as PluginDatabaseHandle<Definition>
		} catch (error) {
			this.definition = undefined
			throw error
		}
	}
}

function coordinatorFor(ctx: CoreContext): DatabaseCoordinator {
	const root = ctx.root
	let coordinator = coordinators.get(root)
	if (!coordinator) {
		coordinator = new DatabaseCoordinator(root)
		coordinators.set(root, coordinator)
	}
	return coordinator
}

export function withDatabasePluginContext<T extends CoreContext.Config>(config: T): T {
	const registry =
		config.registry && typeof config.registry === 'object'
			? (config.registry as Record<string, unknown>)
			: {}
	const current = Array.isArray(registry.pluginCTXIsolate)
		? (registry.pluginCTXIsolate as unknown[])
		: []
	if (current.includes(DatabaseService)) return config
	return {
		...config,
		registry: { ...registry, pluginCTXIsolate: [...current, DatabaseService] },
	} as T
}

/** @internal Workbench live-query bridge. */
export function subscribeDatabaseHandle(
	handle: PluginDatabaseHandle,
	tables: readonly unknown[],
	listener: () => void,
): () => void {
	if (!(handle instanceof OwnerDatabaseHandle)) {
		throw new TypeError('[pluxel/database] liveQuery requires a Pluxel database handle')
	}
	const names = new Set(tables.map(readTableName))
	return handle.subscribe(names, listener)
}

/** @internal */
export function databaseHandleOwnsTables(
	handle: PluginDatabaseHandle,
	tables: readonly unknown[],
): boolean {
	if (!(handle instanceof OwnerDatabaseHandle)) return false
	const known = new Set(schemaTableNames((handle as any).definition))
	return tables.every((table) => known.has(readTableName(table)))
}

function schemaTableNames(definition: DatabaseDefinition): string[] {
	const names: string[] = []
	for (const value of Object.values(definition.schema)) {
		if (!is(value, PgTable)) continue
		const table = value as PgTable
		if ((table as any)[Symbol.for('drizzle:Schema')]) {
			throw new Error('[pluxel/database] pgSchema() tables are not allowed')
		}
		names.push(getTableName(table))
	}
	return [...new Set(names)].sort()
}

function readTableName(value: unknown): string {
	if (!is(value, PgTable))
		throw new TypeError('[pluxel/database] dependsOn requires Drizzle pgTable values')
	return getTableName(value as PgTable)
}

async function installOutboxTrigger(db: AnyDatabase, ownerSchema: string, table: string) {
	const trigger = `pluxel_outbox_${createHash('sha256').update(table).digest('hex').slice(0, 12)}`
	await executeSqlStatements(
		db,
		`
			DROP TRIGGER IF EXISTS ${quoteIdent(trigger)} ON ${quoteIdent(ownerSchema)}.${quoteIdent(table)};
			CREATE TRIGGER ${quoteIdent(trigger)} AFTER INSERT OR UPDATE OR DELETE
			ON ${quoteIdent(ownerSchema)}.${quoteIdent(table)} FOR EACH STATEMENT
			EXECUTE FUNCTION ${SYSTEM_SCHEMA}.capture_change();
		`,
	)
}

function legacyPhysicalSchemaFor(ownerId: string): string {
	const slug = ownerId
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
	const hash = createHash('sha256').update(ownerId).digest('hex').slice(0, 16)
	return `pluxel_${slug.slice(0, 36) || 'plugin'}_${hash}`
}

function physicalSchemaForInstance(ownerId: string, instanceId: string): string {
	const slug = ownerId
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
	const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 8)
	const instanceHash = createHash('sha256').update(instanceId).digest('hex').slice(0, 12)
	return `pluxel_${slug.slice(0, 24) || 'plugin'}_${ownerHash}_${instanceHash}`
}

function physicalRoleForArtifact(ownerSchema: string): string {
	return `${ownerSchema}_r`
}

async function ensureOwnerRole(db: AnyDatabase, ownerRole: string): Promise<void> {
	await executeSqlStatements(
		db,
		`
			DO $pluxel$
			BEGIN
				IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(ownerRole)}) THEN
					CREATE ROLE ${quoteIdent(ownerRole)} NOLOGIN;
				END IF;
			END
			$pluxel$;
			GRANT ${quoteIdent(ownerRole)} TO CURRENT_USER;
		`,
	)
}

async function ensureExtensions(db: AnyDatabase, definition: DatabaseDefinition): Promise<void> {
	for (const extension of definition.requirements.extensions ?? []) {
		if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(extension)) {
			throw new Error(`[pluxel/database] invalid PostgreSQL extension name "${extension}"`)
		}
		await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`))
	}
}

function databaseArtifactFingerprint(
	definition: DatabaseDefinition,
	artifact: DatabaseArtifact,
	tables = schemaTableNames(definition),
): string {
	const hash = createHash('sha256')
	hash.update('pluxel-database-instance-v1\0')
	hash.update(artifact.evolution)
	hash.update(artifact.lineage)
	for (const extension of [...(definition.requirements.extensions ?? [])].sort()) {
		hash.update(`\0extension:${extension}`)
	}
	for (const table of tables) hash.update(`\0table:${table}`)
	if (artifact.evolution === 'migrations') {
		for (const migration of artifact.migrations) {
			hash.update(`\0migration:${migration.id}:${migration.checksum}:`)
			hash.update(migration.sql)
		}
	}
	return hash.digest('hex')
}

function validateMigrationArtifact(artifact: DatabaseArtifact): void {
	for (const migration of artifact.migrations) {
		const checksum = createHash('sha256').update(migration.sql).digest('hex')
		if (checksum !== migration.checksum) {
			throw new Error(
				`[pluxel/database] migration artifact checksum is invalid: ${artifact.lineage}/${migration.id}`,
			)
		}
	}
}

function instanceMatches(
	instance: PreparedDatabaseInstance,
	lineage: string,
	fingerprint: string,
): boolean {
	return (
		instance.lineage === lineage &&
		instance.artifactFingerprint === fingerprint &&
		instance.runtimeVersion === DATABASE_INSTANCE_RUNTIME_VERSION
	)
}

async function lockDatabaseOwner(
	db: AnyDatabase,
	ownerId: string,
	mode: 'shared' | 'exclusive',
): Promise<void> {
	const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'
	await db.execute(
		sql.raw(`SELECT ${fn}(hashtextextended(${quoteLiteral(`pluxel/database/${ownerId}`)}, 0))`),
	)
}

async function assertActiveInstance(
	db: AnyDatabase,
	instance: PreparedDatabaseInstance,
): Promise<void> {
	const result = await db.execute(
		sql.raw(
			`SELECT 1 FROM ${SYSTEM_SCHEMA}.database_instances WHERE instance_id = ${quoteLiteral(instance.instanceId)} AND owner_id = ${quoteLiteral(instance.ownerId)} AND state = 'active'`,
		),
	)
	if (resultRows(result).length === 0) {
		throw new Error('[pluxel/database] database handle instance has been replaced')
	}
}

async function readActiveInstance(
	db: AnyDatabase,
	ownerId: string,
): Promise<PreparedDatabaseInstance | undefined> {
	const result = await db.execute(
		sql.raw(
			`SELECT instance_id, owner_id, lineage, physical_schema, physical_role, artifact_fingerprint, runtime_version FROM ${SYSTEM_SCHEMA}.database_instances WHERE owner_id = ${quoteLiteral(ownerId)} AND state = 'active'`,
		),
	)
	const row = resultRows(result)[0]
	return row ? databaseInstanceFromRow(row) : undefined
}

function databaseInstanceFromRow(row: Record<string, unknown>): PreparedDatabaseInstance {
	return {
		instanceId: String(row.instance_id),
		ownerId: String(row.owner_id),
		lineage: String(row.lineage),
		ownerSchema: String(row.physical_schema),
		ownerRole: String(row.physical_role),
		artifactFingerprint: String(row.artifact_fingerprint),
		runtimeVersion: Number(row.runtime_version),
	}
}

async function readAppliedMigrations(
	db: AnyDatabase,
	instanceId: string,
): Promise<Map<string, string>> {
	const result = await db.execute(
		sql.raw(
			`SELECT migration_id, checksum FROM ${SYSTEM_SCHEMA}.database_migrations WHERE instance_id = ${quoteLiteral(instanceId)} ORDER BY migration_id`,
		),
	)
	return new Map(resultRows(result).map((row) => [String(row.migration_id), String(row.checksum)]))
}

function assertMigrationHistory(
	instance: PreparedDatabaseInstance,
	artifact: DatabaseArtifact,
	applied: ReadonlyMap<string, string>,
): void {
	const entries = [...applied]
	for (let index = 0; index < entries.length; index += 1) {
		const [id, checksum] = entries[index]!
		const expected = artifact.migrations[index]
		if (!expected || expected.id !== id) {
			throw new Error(
				`[pluxel/database] migration history is not an immutable prefix of lineage "${artifact.lineage}": ${id}`,
			)
		}
		if (expected.checksum !== checksum) {
			throw new Error(
				`[pluxel/database] migration checksum changed: ${instance.ownerId}/${artifact.lineage}/${id}`,
			)
		}
	}
}

async function databaseSchemaExists(db: AnyDatabase, schema: string): Promise<boolean> {
	const result = await db.execute(
		sql.raw(
			`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${quoteLiteral(schema)} LIMIT 1`,
		),
	)
	return resultRows(result).length > 0
}

async function grantOwnerTables(
	db: AnyDatabase,
	ownerSchema: string,
	ownerRole: string,
): Promise<void> {
	await executeSqlStatements(
		db,
		`
			GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdent(ownerSchema)} TO ${quoteIdent(ownerRole)};
			GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdent(ownerSchema)} TO ${quoteIdent(ownerRole)};
		`,
	)
}

async function createAdapter(
	config: DatabaseConfig | undefined,
	persistence: CoreContext.Config['persistence'],
): Promise<DatabaseAdapter> {
	if (config && config.driver === 'postgres') {
		const [{ Pool }, { drizzle }] = await Promise.all([
			import('pg'),
			import('drizzle-orm/node-postgres'),
		])
		const pool = new Pool({
			connectionString: config.connectionString,
			max: config.pool?.max ?? 10,
			idleTimeoutMillis: config.pool?.idleTimeoutMs,
			connectionTimeoutMillis: config.pool?.connectionTimeoutMs,
			ssl:
				config.tls === undefined
					? undefined
					: config.tls === 'verify-full'
						? { rejectUnauthorized: true }
						: { rejectUnauthorized: false },
		})
		return {
			driver: 'postgres',
			db: drizzle(pool) as AnyDatabase,
			concurrency: config.pool?.max ?? 10,
			close: async () => await pool.end(),
		}
	}

	const [{ PGlite }, { drizzle }] = await Promise.all([
		import('@electric-sql/pglite'),
		import('drizzle-orm/pglite'),
	])
	const configured = config && config.driver === 'pglite' ? config.dataDir : undefined
	const dataDir = configured ?? defaultPgliteDataDir(persistence)
	if (!dataDir.includes('://')) await mkdir(dirname(dataDir), { recursive: true })
	const client = new PGlite(dataDir)
	await client.waitReady
	return {
		driver: 'pglite',
		db: drizzle(client) as AnyDatabase,
		concurrency: 1,
		close: async () => await client.close(),
	}
}

function defaultPgliteDataDir(persistence: CoreContext.Config['persistence']): string {
	if (typeof persistence === 'string') return join(persistence, 'database', 'pglite')
	if (persistence && typeof persistence === 'object' && persistence.mode === 'memory')
		return 'memory://'
	return join('.pluxel', 'persistence', 'database', 'pglite')
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(result)) return result as Array<Record<string, unknown>>
	if (result && typeof result === 'object' && Array.isArray((result as any).rows)) {
		return (result as any).rows
	}
	return []
}

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

async function executeSqlStatements(db: AnyDatabase, source: string): Promise<void> {
	for (const statement of splitPostgresStatements(source)) {
		await db.execute(sql.raw(statement))
	}
}

function splitPostgresStatements(source: string): string[] {
	const statements: string[] = []
	let start = 0
	let index = 0
	let single = false
	let double = false
	let lineComment = false
	let blockComment = false
	let dollarTag: string | undefined
	while (index < source.length) {
		const char = source[index]!
		const next = source[index + 1]
		if (lineComment) {
			if (char === '\n') lineComment = false
			index++
			continue
		}
		if (blockComment) {
			if (char === '*' && next === '/') {
				blockComment = false
				index += 2
				continue
			}
			index++
			continue
		}
		if (dollarTag) {
			if (source.startsWith(dollarTag, index)) {
				index += dollarTag.length
				dollarTag = undefined
				continue
			}
			index++
			continue
		}
		if (single) {
			if (char === "'" && next === "'") {
				index += 2
				continue
			}
			if (char === "'") single = false
			index++
			continue
		}
		if (double) {
			if (char === '"' && next === '"') {
				index += 2
				continue
			}
			if (char === '"') double = false
			index++
			continue
		}
		if (char === '-' && next === '-') {
			lineComment = true
			index += 2
			continue
		}
		if (char === '/' && next === '*') {
			blockComment = true
			index += 2
			continue
		}
		if (char === "'") {
			single = true
			index++
			continue
		}
		if (char === '"') {
			double = true
			index++
			continue
		}
		if (char === '$') {
			const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
			if (match) {
				dollarTag = match[0]
				index += dollarTag.length
				continue
			}
		}
		if (char === ';') {
			const statement = source.slice(start, index).trim()
			if (statement) statements.push(statement)
			start = index + 1
		}
		index++
	}
	const tail = source.slice(start).trim()
	if (tail) statements.push(tail)
	return statements
}
