import { runDatabaseOperation } from '../owner'
import { createHash, randomUUID } from 'node:crypto'
import type { Context as CoreContext } from '@pluxel/core'
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable, type PgDatabase } from 'drizzle-orm/pg-core'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core/session'
import type { DatabaseArtifact } from '../artifact'
import { migrateDatabaseInstance } from './migrations'
import { grantExtensionUsage, resolveExtensionSchemas } from './extensions'
import { validateMigrationArtifact } from '../node-migrations'
import { prepareDatabaseSystem, SYSTEM_SCHEMA } from './system'
import type {
	DatabaseDefinition,
	PluginDatabaseClient,
	PluginDatabaseHandle,
	PluginDatabaseTransaction,
} from '../../pg'

export type DatabaseBackend = (onError: (error: Error) => void) => Promise<DatabaseAdapter>

type AnyDatabase = PgDatabase<PgQueryResultHKT, any>

export type DatabaseAdapter = {
	driver: 'pglite' | 'postgres'
	db: PgDatabase<PgQueryResultHKT, Record<never, never>>
	withSchema<Schema extends Record<string, unknown>>(
		schema: Schema,
	): PgDatabase<PgQueryResultHKT, Schema>
	concurrency: number
	close(): Promise<void>
}

class FairScheduler {
	private readonly queues = new Map<string, Array<() => void>>()
	private running = 0

	constructor(
		private readonly concurrency: number,
		private readonly pendingLimit = 100,
		private readonly timeoutMs = 30_000,
	) {}

	async run<T>(owner: string, operation: () => Promise<T>): Promise<T> {
		if (this.running < this.concurrency) this.running++
		else await this.waitForSlot(owner)
		try {
			return await operation()
		} finally {
			this.releaseSlot()
		}
	}

	private waitForSlot(owner: string): Promise<void> {
		const queue = this.queues.get(owner) ?? []
		if (queue.length >= this.pendingLimit) {
			throw new Error(`[pluxel/pg] pending operation limit exceeded for plugin "${owner}"`)
		}
		this.queues.set(owner, queue)
		return new Promise<void>((resolve, reject) => {
			const resume = () => {
				clearTimeout(timer)
				resolve()
			}
			const timer = setTimeout(() => {
				queue.splice(queue.indexOf(resume), 1)
				if (queue.length === 0) this.queues.delete(owner)
				reject(new Error(`[pluxel/pg] operation timed out while queued for plugin "${owner}"`))
			}, this.timeoutMs)
			queue.push(resume)
		})
	}

	private releaseSlot(): void {
		const next = this.queues.entries().next()
		if (next.done) {
			this.running--
			return
		}
		// Hand off the occupied slot. Owners with more work rejoin at the back.
		const [owner, queue] = next.value
		const resume = queue.shift()!
		this.queues.delete(owner)
		if (queue.length > 0) this.queues.set(owner, queue)
		resume()
	}
}

type Invalidation = Readonly<{ ownerSchema: string; table: string; revision: string }>
type InvalidationListener = (event: Invalidation) => void

const DATABASE_INSTANCE_RUNTIME_VERSION = 1

type DatabaseInstance = Readonly<{
	instanceId: string
	ownerId: string
	lineage: string
	ownerSchema: string
	ownerRole: string
	artifactFingerprint: string
	runtimeVersion: number
}>
type PreparedDatabaseInstance = DatabaseInstance & Readonly<{ searchPath: string }>

class DatabaseCoordinator {
	private adapterTask?: Promise<DatabaseAdapter>
	private scheduler?: FairScheduler
	private systemReady?: Promise<void>
	private readonly preparing = new Map<string, Promise<PreparedDatabaseInstance>>()
	private readonly listeners = new Set<InvalidationListener>()
	private pollTimer?: ReturnType<typeof setInterval>
	private dispatchTask?: Promise<void>
	private checkpoint = '0'
	private disposed = false

	constructor(
		private readonly root: CoreContext,
		private readonly backend: DatabaseBackend,
	) {
		root.effects.defer(() => this.dispose(), { tag: 'DatabaseCoordinator' })
	}

	async acquire<Definition extends DatabaseDefinition>(
		owner: CoreContext,
		ownerId: string,
		definition: Definition,
		artifact: DatabaseArtifact,
	): Promise<PluginDatabaseHandle<Definition>> {
		const { client, instance } = await this.prepare(ownerId, definition, artifact)
		return new OwnerDatabaseHandle<Definition>(this, owner, instance, client)
	}

	operation<Definition extends DatabaseDefinition, Result>(
		instance: PreparedDatabaseInstance,
		client: PluginDatabaseClient<Definition>,
		readonly: boolean,
		callback: (tx: PluginDatabaseTransaction<Definition>) => Result | Promise<Result>,
	): Promise<Result> {
		if (this.disposed) {
			return Promise.reject(new Error('[pluxel/pg] database coordinator is stopped'))
		}
		const { ownerId } = instance
		return this.schedule(ownerId, async (adapter) => {
			const result = await client.transaction(async (tx) => {
				if (readonly) await tx.execute(sql.raw('SET TRANSACTION READ ONLY'))
				if (adapter.driver === 'postgres') {
					await lockDatabaseOwner(tx, ownerId, 'shared')
				}
				await configureOperationContext(tx, instance, readonly ? undefined : randomUUID())
				await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(instance.ownerRole)}`)
				return await callback(tx)
			})
			if (!readonly) this.requestDispatch()
			return result
		})
	}

	subscribe(
		owner: CoreContext,
		ownerSchema: string,
		tables: ReadonlySet<string>,
		listener: () => void,
	): () => void {
		const wrapped: InvalidationListener = (event) => {
			if (event.ownerSchema === ownerSchema && tables.has(event.table)) listener()
		}
		const guard = owner.effects.defer(
			() => {
				this.listeners.delete(wrapped)
				if (this.listeners.size === 0 && this.pollTimer) {
					clearInterval(this.pollTimer)
					this.pollTimer = undefined
				}
			},
			{ tag: 'PgSubscription' },
		)
		this.listeners.add(wrapped)
		if (!this.pollTimer) {
			this.pollTimer = setInterval(() => {
				this.requestDispatch()
			}, 500)
		}
		return () => {
			guard.dispose()
		}
	}

	private async prepare<Definition extends DatabaseDefinition>(
		ownerId: string,
		definition: Definition,
		artifact: DatabaseArtifact,
	): Promise<{ client: PluginDatabaseClient<Definition>; instance: PreparedDatabaseInstance }> {
		const tables = schemaTableNames(definition)
		validateMigrationArtifact(artifact)
		const fingerprint = databaseArtifactFingerprint(definition, artifact, tables)
		await this.ensureSystem()
		const adapter = await this.adapter()
		const client = adapter.withSchema<Definition['schema']>(definition.schema)

		const key = `${ownerId}\0${fingerprint}`
		let task = this.preparing.get(key)
		if (!task) {
			task = this.prepareOwner(ownerId, definition, artifact, fingerprint, tables)
			this.preparing.set(key, task)
		}
		try {
			return { client, instance: await task }
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
		return this.schedule(`$prepare:${ownerId}`, (adapter) =>
			adapter.db.transaction(async (tx) => {
				if (adapter.driver === 'postgres') await lockDatabaseOwner(tx, ownerId, 'exclusive')
				const active = await readActiveInstance(tx, ownerId)
				const current = active?.lineage === artifact.lineage ? active : undefined
				const extensions = await resolveExtensionSchemas(
					tx,
					definition.requirements.extensions ?? [],
					current?.ownerSchema,
				)
				let instance = current
				if (!instance || !instanceMatches(instance, fingerprint)) {
					await tx.execute(sql`SELECT set_config('pluxel.transaction_id', ${randomUUID()}, true)`)
					instance = instance
						? await this.upgradeInstance(tx, instance, extensions, artifact, fingerprint, tables)
						: await this.createInstance(
								tx,
								ownerId,
								active,
								extensions,
								artifact,
								fingerprint,
								tables,
							)
				}
				await grantExtensionUsage(tx, instance.ownerRole, extensions)
				return { ...instance, searchPath: ownerSearchPath(instance.ownerSchema, extensions) }
			}),
		)
	}

	private async upgradeInstance(
		tx: PgTransaction<PgQueryResultHKT>,
		instance: DatabaseInstance,
		extensions: readonly string[],
		artifact: DatabaseArtifact,
		fingerprint: string,
		tables: readonly string[],
	): Promise<DatabaseInstance> {
		await tx.execute(
			sql`SELECT set_config('search_path', ${ownerSearchPath(instance.ownerSchema, extensions)}, true)`,
		)
		const changed = await migrateDatabaseInstance(tx, instance.instanceId, artifact, 'active')
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
		tx: PgTransaction<PgQueryResultHKT>,
		ownerId: string,
		previous: DatabaseInstance | undefined,
		extensions: readonly string[],
		artifact: DatabaseArtifact,
		fingerprint: string,
		tables: readonly string[],
	): Promise<DatabaseInstance> {
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
		await tx.execute(
			sql`SELECT set_config('search_path', ${ownerSearchPath(ownerSchema, extensions)}, true)`,
		)
		const instance: DatabaseInstance = {
			instanceId,
			ownerId,
			lineage: artifact.lineage,
			ownerSchema,
			ownerRole,
			artifactFingerprint: fingerprint,
			runtimeVersion: DATABASE_INSTANCE_RUNTIME_VERSION,
		}
		await migrateDatabaseInstance(tx, instanceId, artifact, 'new')
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

	private ensureSystem(): Promise<void> {
		this.systemReady ??= this.initializeSystem().catch((error) => {
			this.systemReady = undefined
			throw error
		})
		return this.systemReady
	}

	private async initializeSystem(): Promise<void> {
		const adapter = await this.adapter()
		await adapter.db.transaction(async (tx) => {
			if (adapter.driver === 'postgres') {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('pluxel/system/pg', 0))`)
			}
			await prepareDatabaseSystem(tx)
		})
		const [latest] = await adapter.db._.session.all<{ id: string }>(
			sql`SELECT COALESCE(MAX(id), 0)::text AS id FROM ${sql.identifier(SYSTEM_SCHEMA)}.invalidation_log`,
		)
		this.checkpoint = latest!.id
	}

	private async dispatchAndPoll(): Promise<void> {
		if (this.disposed) return
		await this.ensureSystem()
		await this.schedule('$outbox', async (adapter) => {
			await adapter.db.transaction(async (tx) => {
				if (adapter.driver === 'postgres') {
					// A sequence assigns IDs before commit. Keep a poller from seeing a higher ID first.
					await tx.execute(
						sql`LOCK TABLE ${sql.identifier(SYSTEM_SCHEMA)}.invalidation_log IN SHARE ROW EXCLUSIVE MODE`,
					)
				}
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
			const events = await adapter.db._.session.all<Invalidation>(sql`
				SELECT id::text AS revision, owner_schema AS "ownerSchema", table_name AS "table"
				FROM ${sql.identifier(SYSTEM_SCHEMA)}.invalidation_log
				WHERE id > ${this.checkpoint}::bigint ORDER BY id LIMIT 1000
			`)
			for (const event of events) {
				this.checkpoint = event.revision
				for (const listener of this.listeners) {
					try {
						listener(event)
					} catch (error) {
						this.root.logger.error('database invalidation listener failed', { error })
					}
				}
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
		this.adapterTask ??= this.backend((error) => {
			this.root.logger.error('database PostgreSQL pool connection failed', { error })
		}).catch((error) => {
			this.adapterTask = undefined
			throw error
		})
		return this.adapterTask
	}

	private async schedule<T>(
		owner: string,
		operation: (adapter: DatabaseAdapter) => Promise<T>,
	): Promise<T> {
		const adapter = await this.adapter()
		this.scheduler ??= new FairScheduler(adapter.concurrency)
		return this.scheduler.run(owner, () => operation(adapter))
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
	private active = true

	constructor(
		private readonly coordinator: DatabaseCoordinator,
		private readonly owner: CoreContext,
		private readonly instance: PreparedDatabaseInstance,
		private readonly client: PluginDatabaseClient<Definition>,
	) {
		owner.effects.defer(
			() => {
				this.active = false
			},
			{ tag: 'PluginDatabase' },
		)
	}

	read<Result>(
		callback: (db: PluginDatabaseClient<Definition>) => Result | Promise<Result>,
	): Promise<Result> {
		return this.run(true, callback)
	}

	transaction<Result>(
		callback: (tx: PluginDatabaseTransaction<Definition>) => Result | Promise<Result>,
	): Promise<Result> {
		return this.run(false, callback)
	}

	subscribe(tables: ReadonlySet<string>, listener: () => void): () => void {
		this.assertActive()
		return this.coordinator.subscribe(this.owner, this.instance.ownerSchema, tables, listener)
	}

	private run<Result>(
		readonly: boolean,
		callback: (tx: PluginDatabaseTransaction<Definition>) => Result | Promise<Result>,
	): Promise<Result> {
		if (!this.active) {
			return Promise.reject(new Error('[pluxel/pg] database handle owner has stopped'))
		}
		if (typeof callback !== 'function') {
			return Promise.reject(new TypeError('[pluxel/pg] operation requires a callback'))
		}
		return runDatabaseOperation(this.owner, () =>
			this.coordinator.operation<Definition, Result>(
				this.instance,
				this.client,
				readonly,
				callback,
			),
		)
	}

	private assertActive(): void {
		if (!this.active) throw new Error('[pluxel/pg] database handle owner has stopped')
	}
}

const coordinators = new WeakMap<CoreContext, DatabaseCoordinator>()

export function acquirePgDatabase<Definition extends DatabaseDefinition>(
	owner: CoreContext,
	ownerId: string,
	definition: Definition,
	artifact: DatabaseArtifact,
	backend: DatabaseBackend,
): Promise<PluginDatabaseHandle<Definition>> {
	const root = owner.root
	let coordinator = coordinators.get(root)
	if (!coordinator) {
		coordinator = new DatabaseCoordinator(root, backend)
		coordinators.set(root, coordinator)
	}
	return coordinator.acquire(owner, ownerId, definition, artifact)
}

/** @internal Owner-scoped table invalidation primitive. */
export function subscribeDatabaseHandle(
	handle: PluginDatabaseHandle,
	tables: readonly unknown[],
	listener: () => void,
): () => void {
	if (!(handle instanceof OwnerDatabaseHandle)) {
		throw new TypeError('[pluxel/pg] subscription requires a Pluxel database handle')
	}
	const names = new Set(tables.map(readTableName))
	return handle.subscribe(names, listener)
}

function schemaTableNames(definition: DatabaseDefinition): string[] {
	const names: string[] = []
	for (const value of Object.values(definition.schema)) {
		if (!is(value, PgTable)) continue
		const table = value as PgTable
		if ((table as any)[Symbol.for('drizzle:Schema')]) {
			throw new Error('[pluxel/pg] pgSchema() tables are not allowed')
		}
		names.push(getTableName(table))
	}
	return [...new Set(names)].sort()
}

function readTableName(value: unknown): string {
	if (!is(value, PgTable))
		throw new TypeError('[pluxel/pg] dependsOn requires Drizzle pgTable values')
	return getTableName(value as PgTable)
}

async function installOutboxTrigger(db: AnyDatabase, ownerSchema: string, table: string) {
	const trigger = `pluxel_outbox_${createHash('sha256').update(table).digest('hex').slice(0, 12)}`
	const relation = sql`${sql.identifier(ownerSchema)}.${sql.identifier(table)}`
	await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(trigger)} ON ${relation}`)
	await db.execute(sql`CREATE TRIGGER ${sql.identifier(trigger)} AFTER INSERT OR UPDATE OR DELETE
		ON ${relation} FOR EACH STATEMENT EXECUTE FUNCTION ${sql.identifier(SYSTEM_SCHEMA)}.capture_change()`)
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
	const role = sql.identifier(ownerRole)
	await db.execute(sql`CREATE ROLE ${role} NOLOGIN`)
	await db.execute(sql`GRANT ${role} TO CURRENT_USER`)
}

function ownerSearchPath(ownerSchema: string, extensions: readonly string[]): string {
	return [ownerSchema, 'pg_catalog', ...extensions].map(quoteIdent).join(', ')
}

function databaseArtifactFingerprint(
	definition: DatabaseDefinition,
	artifact: DatabaseArtifact,
	tables = schemaTableNames(definition),
): string {
	const hash = createHash('sha256')
	hash.update('pluxel-database-instance-v2\0')
	hash.update(artifact.evolution)
	hash.update(artifact.lineage)
	for (const extension of [...(definition.requirements.extensions ?? [])].sort()) {
		hash.update(`\0extension:${extension}`)
	}
	for (const table of tables) hash.update(`\0table:${table}`)
	if (artifact.evolution === 'migrations') {
		for (const migration of artifact.migrations) {
			hash.update(`\0migration:${migration.folderMillis}:${migration.hash}`)
		}
	}
	return hash.digest('hex')
}

function instanceMatches(instance: DatabaseInstance, fingerprint: string): boolean {
	return (
		instance.artifactFingerprint === fingerprint &&
		instance.runtimeVersion === DATABASE_INSTANCE_RUNTIME_VERSION
	)
}

async function configureOperationContext(
	db: AnyDatabase,
	instance: PreparedDatabaseInstance,
	transactionId: string | undefined,
): Promise<void> {
	const result = await db.execute(sql`
		SELECT set_config('search_path', ${instance.searchPath}, true),
			set_config('statement_timeout', '30000ms', true),
			set_config('lock_timeout', '5000ms', true),
			set_config('idle_in_transaction_session_timeout', '30000ms', true)
			${transactionId ? sql`, set_config('pluxel.transaction_id', ${transactionId}, true)` : sql.empty()}
		FROM ${sql.identifier(SYSTEM_SCHEMA)}.database_instances
		WHERE instance_id = ${instance.instanceId} AND owner_id = ${instance.ownerId} AND state = 'active'
	`)
	if (resultRows(result).length === 0) {
		throw new Error('[pluxel/pg] database handle instance has been replaced')
	}
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

async function readActiveInstance(
	db: AnyDatabase,
	ownerId: string,
): Promise<DatabaseInstance | undefined> {
	const result = await db.execute(
		sql.raw(
			`SELECT instance_id, owner_id, lineage, physical_schema, physical_role, artifact_fingerprint, runtime_version FROM ${SYSTEM_SCHEMA}.database_instances WHERE owner_id = ${quoteLiteral(ownerId)} AND state = 'active'`,
		),
	)
	const row = resultRows(result)[0]
	return row ? databaseInstanceFromRow(row) : undefined
}

function databaseInstanceFromRow(row: Record<string, unknown>): DatabaseInstance {
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

async function grantOwnerTables(
	db: AnyDatabase,
	ownerSchema: string,
	ownerRole: string,
): Promise<void> {
	const schema = sql.identifier(ownerSchema)
	const role = sql.identifier(ownerRole)
	await db.execute(
		sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
	)
	await db.execute(sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`)
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
