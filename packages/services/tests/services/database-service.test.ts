import {
	Pg,
	defineDatabase,
	type DatabaseDefinition,
	type PluginDatabaseHandle,
} from '@pluxel/services/pg'
import { pglite } from '@pluxel/services/pg/pglite'
import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { hstore } from '@electric-sql/pglite/contrib/hstore'
import { ltree } from '@electric-sql/pglite/contrib/ltree'
import { createTestHost } from '@pluxel/test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { customType, pgTable, text } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
	createServiceInternalTestHarness,
	type ServiceInternalTestHarness,
} from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { type DatabaseArtifact } from '../../src/database/artifact'
import { attachPostgresPoolErrorHandler } from '../../src/database/pg/adapters/postgres'
import { subscribeDatabaseHandle } from '../../src/database/pg/coordinator'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const migrationSql = `
	CREATE TABLE items (
		id text PRIMARY KEY,
		value text NOT NULL
	)
`.trim()

const addTagMigrationSql = `
	ALTER TABLE items ADD COLUMN tag text NOT NULL DEFAULT 'legacy';
	--> statement-breakpoint
	UPDATE items SET value = value || '-migrated'
`.trim()

function migration(folderMillis: number, source: string) {
	return {
		folderMillis,
		hash: createHash('sha256').update(source).digest('hex'),
		bps: true,
		sql: source.split('--> statement-breakpoint'),
	}
}

// The server compiler supplies the second argument at the plugin's declaration.
const compiledDatabase = defineDatabase as <Schema extends Record<string, unknown>>(
	input: Parameters<typeof defineDatabase<Schema>>[0],
	artifact: DatabaseArtifact,
) => DatabaseDefinition<Schema>

function databaseFixture(lineage = 'main', migrations = [migration(1000, migrationSql)]) {
	const items = pgTable('items', {
		id: text('id').primaryKey(),
		value: text('value').notNull(),
	})
	return {
		items,
		database: compiledDatabase(
			{ schema: { items } },
			{ evolution: 'migrations', lineage, migrations },
		),
	}
}

function upgradedDatabaseFixture(lineage = 'main') {
	const items = pgTable('items', {
		id: text('id').primaryKey(),
		value: text('value').notNull(),
		tag: text('tag').notNull().default('legacy'),
	})
	const artifact: DatabaseArtifact = {
		evolution: 'migrations',
		lineage,
		migrations: [migration(1000, migrationSql), migration(2000, addTagMigrationSql)],
	}
	return { items, artifact, database: compiledDatabase({ schema: { items } }, artifact) }
}

function invalidDatabaseFixture(lineage: string) {
	const source = `${migrationSql};
--> statement-breakpoint
SELECT * FROM migration_table_that_does_not_exist`
	return databaseFixture(lineage, [migration(1000, source)])
}

function resetDatabaseFixture(source: string) {
	const items = pgTable('items', {
		id: text('id').primaryKey(),
		value: text('value').notNull(),
	})
	const evolution = 'reset-on-schema-change'
	return {
		items,
		database: compiledDatabase(
			{ schema: { items }, evolution },
			{ evolution, lineage: 'reset-stable-schema', migrations: [migration(0, source)] },
		),
	}
}

async function resetRuntimeHost(host: ServiceInternalTestHarness): Promise<void> {
	const plugins = host.plugins()
	if (plugins.length === 0) return
	host.remove(plugins)
	await host.commit()
}

describe('DatabaseService', () => {
	let databaseHost: ServiceInternalTestHarness

	beforeAll(async () => {
		databaseHost = await createServiceInternalTestHarness({
			workbench: false,
			services: [pglite({ dataDir: 'memory://' })],
		})
	})

	afterAll(() => databaseHost.dispose())

	it('contains idle PostgreSQL pool errors at the database service boundary', () => {
		const pool = new EventEmitter()
		const report = vi.fn()
		attachPostgresPoolErrorHandler(pool as never, report)
		const failure = new Error('idle connection failed')

		expect(() => pool.emit('error', failure)).not.toThrow()
		expect(report).toHaveBeenCalledWith(failure)

		report.mockImplementation(() => {
			throw new Error('logger failed')
		})
		expect(() => pool.emit('error', failure)).not.toThrow()
	})

	it('drains accepted owner operations before teardown completes', async () => {
		const definition = databaseFixture('owner-cancellation')
		const host = databaseHost
		let releaseOperation: (() => void) | undefined
		let runningOperation: Promise<void> | undefined
		try {
			@Plugin({ displayName: 'QueuedDatabasePlugin', startTimeoutMs: 30_000 })
			class QueuedDatabasePlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(definition.database)
				}
			}

			lowerTestPlugin(QueuedDatabasePlugin)
			host.add(QueuedDatabasePlugin)
			host.cfg(QueuedDatabasePlugin).setAutoStart(true)
			host.start(QueuedDatabasePlugin)
			await host.commit()
			const database = host.require(QueuedDatabasePlugin).db
			let markRunning!: () => void
			const running = new Promise<void>((resolveRunning) => {
				markRunning = resolveRunning
			})
			const release = new Promise<void>((resolveRelease) => {
				releaseOperation = resolveRelease
			})
			runningOperation = database.read(async () => {
				markRunning()
				await release
			})
			await running

			const queuedOperation = database.read(() => 'completed')
			host.remove(QueuedDatabasePlugin)
			const stopping = host.commit()
			await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
			releaseOperation()
			releaseOperation = undefined
			await stopping
			await expect(queuedOperation).resolves.toBe('completed')
		} finally {
			releaseOperation?.()
			await runningOperation?.catch((): undefined => undefined)
			await resetRuntimeHost(host)
		}
	}, 60_000)

	it('rejects new operations from a cached handle after owner teardown', async () => {
		const definition = databaseFixture('cached-owner-handle')
		const host = databaseHost
		try {
			@Plugin({ displayName: 'CachedDatabaseHandlePlugin' })
			class CachedDatabaseHandlePlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(definition.database)
				}
			}

			lowerTestPlugin(CachedDatabaseHandlePlugin)
			host.add(CachedDatabaseHandlePlugin)
			host.cfg(CachedDatabaseHandlePlugin).setAutoStart(true)
			host.start(CachedDatabaseHandlePlugin)
			await host.commit()
			const database = host.require(CachedDatabaseHandlePlugin).db
			const retiredListener = vi.fn()
			subscribeDatabaseHandle(database, [definition.items], retiredListener)

			host.remove(CachedDatabaseHandlePlugin)
			await host.commit()

			await expect(database.read((db) => db.select().from(definition.items))).rejects.toThrow(
				'database handle owner has stopped',
			)
			expect(() =>
				subscribeDatabaseHandle(database, [definition.items], (): undefined => undefined),
			).toThrow('database handle owner has stopped')

			host.add(CachedDatabaseHandlePlugin)
			host.start(CachedDatabaseHandlePlugin)
			await host.commit()
			const next = host.require(CachedDatabaseHandlePlugin).db
			const published = Promise.withResolvers<void>()
			subscribeDatabaseHandle(next, [definition.items], published.resolve)
			await next.transaction((tx) =>
				tx.insert(definition.items).values({ id: 'item', value: 'new' }),
			)
			await published.promise
			expect(retiredListener).not.toHaveBeenCalled()
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('schedules isolated owners fairly and publishes only their committed writes', async () => {
		const definition = databaseFixture()
		const host = databaseHost
		try {
			@Plugin({ displayName: 'DatabaseLeft' })
			class DatabaseLeft extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(definition.database)
				}
			}

			@Plugin({ displayName: 'DatabaseRight' })
			class DatabaseRight extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(definition.database)
				}
			}

			lowerTestPlugin(DatabaseLeft)
			lowerTestPlugin(DatabaseRight)
			host.add([DatabaseLeft, DatabaseRight])
			host.cfg(DatabaseLeft).setAutoStart(true)
			host.start(DatabaseLeft)
			host.cfg(DatabaseRight).setAutoStart(true)
			host.start(DatabaseRight)
			await host.commit()

			const left = host.require(DatabaseLeft).db
			const right = host.require(DatabaseRight).db
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const held = left.read(async () => {
				entered.resolve()
				await release.promise
			})
			await entered.promise
			const order: string[] = []
			const queued = [
				left.read(() => order.push('left 1')),
				left.read(() => order.push('left 2')),
				right.read(() => order.push('right 1')),
				right.read(() => order.push('right 2')),
			]
			release.resolve()
			await Promise.all([held, ...queued])
			expect(order).toEqual(['left 1', 'right 1', 'left 2', 'right 2'])
			const leftPublished = Promise.withResolvers<void>()
			const rightPublished = vi.fn()
			const broken = vi.fn(() => {
				throw new Error('observer failed')
			})
			const unsubscribeBroken = subscribeDatabaseHandle(left, [definition.items], broken)
			const unsubscribeLeft = subscribeDatabaseHandle(left, [definition.items], () => {
				leftPublished.resolve()
			})
			const unsubscribeRight = subscribeDatabaseHandle(right, [definition.items], rightPublished)
			try {
				await expect(
					right.transaction(async (tx) => {
						await tx.insert(definition.items).values({ id: 'item', value: 'rolled back' })
						throw new Error('rollback')
					}),
				).rejects.toThrow('rollback')
				await expect(right.read((db) => db.select().from(definition.items))).resolves.toEqual([])

				await left.transaction((tx) =>
					tx.insert(definition.items).values({ id: 'item', value: 'left' }),
				)
				// Observing the later commit confirms the outbox has processed the earlier transaction.
				await leftPublished.promise
				expect(broken).toHaveBeenCalledOnce()
				expect(rightPublished).not.toHaveBeenCalled()
			} finally {
				unsubscribeBroken()
				unsubscribeLeft()
				unsubscribeRight()
			}

			await right.transaction((tx) =>
				tx.insert(definition.items).values({ id: 'item', value: 'right' }),
			)
			await expect(left.read((db) => db.select().from(definition.items))).resolves.toEqual([
				{ id: 'item', value: 'left' },
			])
			await expect(right.read((db) => db.select().from(definition.items))).resolves.toEqual([
				{ id: 'item', value: 'right' },
			])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('keeps read callbacks read-only after owner context setup', async () => {
		const definition = databaseFixture('read-only-context')
		const host = databaseHost
		try {
			@Plugin({ displayName: 'ReadOnlyDatabasePlugin' })
			class ReadOnlyDatabasePlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(definition.database)
				}
			}

			lowerTestPlugin(ReadOnlyDatabasePlugin)
			host.add(ReadOnlyDatabasePlugin)
			host.cfg(ReadOnlyDatabasePlugin).setAutoStart(true)
			host.start(ReadOnlyDatabasePlugin)
			await host.commit()
			const database = host.require(ReadOnlyDatabasePlugin).db

			await expect(
				database.read((db) =>
					db.insert(definition.items).values({ id: 'forbidden', value: 'forbidden' }),
				),
			).rejects.toBeInstanceOf(Error)
			await expect(database.read((db) => db.select().from(definition.items))).resolves.toEqual([])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('fails honestly when the host disables database capability', async () => {
		const definition = databaseFixture()
		await using host = await createServiceInternalTestHarness({
			workbench: false,
			services: [],
		})

		@Plugin({ displayName: 'DisabledDatabasePlugin' })
		class DisabledDatabasePlugin extends BasePlugin {
			override async init() {
				await this.ctx.service(Pg).use(definition.database)
			}
		}
		lowerTestPlugin(DisabledDatabasePlugin)
		host.add(DisabledDatabasePlugin)
		host.cfg(DisabledDatabasePlugin).setAutoStart(true)
		host.start(DisabledDatabasePlugin)
		await expect(host.commit()).rejects.toThrow('Some plugins failed to start')
		expect(host.isRunning(DisabledDatabasePlugin)).toBe(false)
	})

	it('reuses persisted PGlite instance metadata on a clean root restart', async () => {
		const definition = databaseFixture('persistent')
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-instance-'))
		const dataDir = join(root, 'pglite')
		let instanceId: string
		try {
			{
				await using firstHost = await createServiceInternalTestHarness({
					workbench: false,
					services: [pglite({ dataDir })],
				})

				@Plugin({ displayName: 'PersistentDatabasePlugin' })
				class FirstProcessPlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.service(Pg).use(definition.database)
						await this.db.transaction((tx) =>
							tx.insert(definition.items).values({ id: 'kept', value: 'persisted' }),
						)
					}
				}
				lowerTestPlugin(FirstProcessPlugin, { id: 'PersistentDatabasePlugin' })
				firstHost.add(FirstProcessPlugin)
				firstHost.cfg(FirstProcessPlugin).setAutoStart(true)
				firstHost.start(FirstProcessPlugin)
				await firstHost.commit()
				instanceId = (firstHost.require(FirstProcessPlugin).db as any).instance.instanceId
			}

			await using secondHost = await createServiceInternalTestHarness({
				workbench: false,
				services: [pglite({ dataDir })],
			})

			@Plugin({ displayName: 'PersistentDatabasePlugin' })
			class SecondProcessPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(definition.database)
				}
			}
			lowerTestPlugin(SecondProcessPlugin, { id: 'PersistentDatabasePlugin' })
			secondHost.add(SecondProcessPlugin)
			secondHost.cfg(SecondProcessPlugin).setAutoStart(true)
			secondHost.start(SecondProcessPlugin)
			await secondHost.commit()
			const database = secondHost.require(SecondProcessPlugin).db
			expect((database as any).instance.instanceId).toBe(instanceId!)
			await expect(database.read((db) => db.select().from(definition.items))).resolves.toEqual([
				{ id: 'kept', value: 'persisted' },
			])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 30_000)

	it('creates the explicitly selected PGlite directory under a new persistence root', async () => {
		const definition = databaseFixture('default-persistence')
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-default-'))
		const persistence = join(root, 'nested', 'persistence')
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [pglite({ dataDir: join(persistence, 'database') })],
		})
		try {
			@Plugin({ displayName: 'DefaultPersistenceDatabasePlugin' })
			class DefaultPersistenceDatabasePlugin extends BasePlugin {
				override async init() {
					await this.ctx.service(Pg).use(definition.database)
				}
			}
			lowerTestPlugin(DefaultPersistenceDatabasePlugin)
			host.add(DefaultPersistenceDatabasePlugin)
			host.cfg(DefaultPersistenceDatabasePlugin).setAutoStart(true)
			host.start(DefaultPersistenceDatabasePlugin)
			await host.commit()
			expect(host.isRunning(DefaultPersistenceDatabasePlugin)).toBe(true)
		} finally {
			await host.dispose()
			await rm(root, { recursive: true, force: true })
		}
	}, 30_000)

	it('upgrades the active instance in place when lineage is unchanged', async () => {
		const initial = databaseFixture('incremental')
		const upgraded = upgradedDatabaseFixture('incremental')
		const host = databaseHost
		try {
			@Plugin({ displayName: 'IncrementalDatabasePlugin' })
			class InitialPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof initial.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(initial.database)
					await this.db.transaction((tx) =>
						tx.insert(initial.items).values({ id: 'kept', value: 'before' }),
					)
				}
			}
			lowerTestPlugin(InitialPlugin, { id: 'IncrementalDatabasePlugin' })
			host.add(InitialPlugin)
			host.cfg(InitialPlugin).setAutoStart(true)
			host.start(InitialPlugin)
			await host.commit()
			const initialInstance = (host.require(InitialPlugin).db as any).instance.instanceId
			host.remove(InitialPlugin)
			await host.commit()

			@Plugin({ displayName: 'IncrementalDatabasePlugin' })
			class UpgradedPlugin extends BasePlugin {
				get pg() {
					return this.ctx.service(Pg)
				}
			}
			lowerTestPlugin(UpgradedPlugin, { id: 'IncrementalDatabasePlugin' })
			host.add(UpgradedPlugin)
			host.cfg(UpgradedPlugin).setAutoStart(true)
			host.start(UpgradedPlugin)
			await host.commit()
			const pg = host.require(UpgradedPlugin).pg
			const rewritten = databaseFixture('incremental', [migration(1000, migrationSql + '\n')])
			await expect(pg.use(rewritten.database)).rejects.toThrow(/immutable prefix/)

			// Installing a trigger for this absent table fails after Drizzle has executed and
			// journaled the ALTER/UPDATE. Retrying must apply both exactly once.
			const missing = pgTable('missing', { id: text('id') })
			const invalid = compiledDatabase(
				{ schema: { items: upgraded.items, missing } },
				upgraded.artifact,
			)
			await expect(pg.use(invalid)).rejects.toThrow(/missing/)
			const beforeRetry = await pg.use(initial.database)
			await expect(beforeRetry.read((db) => db.query.items.findMany())).resolves.toEqual([
				{ id: 'kept', value: 'before' },
			])
			await host.restart(UpgradedPlugin).commit()
			const next = await host.require(UpgradedPlugin).pg.use(upgraded.database)
			expect((next as any).instance.instanceId).toBe(initialInstance)
			await expect(next.read((db) => db.select().from(upgraded.items))).resolves.toEqual([
				{ id: 'kept', value: 'before-migrated', tag: 'legacy' },
			])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('rejects superseded handles across Hosts borrowing one PGlite database', async () => {
		const first = databaseFixture('release-a')
		const second = databaseFixture('release-b')
		const client = await PGlite.create()
		try {
			const options = { workbench: false as const, services: [pglite(client)] }
			await using firstHost = await createServiceInternalTestHarness(options)
			await using secondHost = await createServiceInternalTestHarness(options)
			@Plugin()
			class RebasedPlugin extends BasePlugin {
				get pg() {
					return this.ctx.service(Pg)
				}
			}
			lowerTestPlugin(RebasedPlugin)
			for (const host of [firstHost, secondHost]) {
				host.add(RebasedPlugin)
				host.start(RebasedPlugin)
				await host.commit()
			}
			const previous = await firstHost.require(RebasedPlugin).pg.use(first.database)
			await previous.transaction((tx) =>
				tx.insert(first.items).values({ id: 'old', value: 'archived' }),
			)
			const next = await secondHost.require(RebasedPlugin).pg.use(second.database)
			await expect(next.read((db) => db.select().from(second.items))).resolves.toEqual([])
			const callback = vi.fn()
			await expect(previous.read(callback)).rejects.toThrow(
				'database handle instance has been replaced',
			)
			await expect(previous.transaction(callback)).rejects.toThrow(
				'database handle instance has been replaced',
			)
			expect(callback).not.toHaveBeenCalled()
			await next.transaction((tx) => tx.insert(second.items).values({ id: 'new', value: 'active' }))
			expect(await next.read((db) => db.query.items.findMany())).toEqual([
				{ id: 'new', value: 'active' },
			])
		} finally {
			await client.close()
		}
	}, 30_000)

	it('shares declared PostgreSQL extensions across forks while keeping private schemas isolated', async () => {
		const client = await PGlite.create({ extensions: { citext, hstore, ltree } })
		try {
			await client.exec(
				`CREATE SCHEMA "app types"; CREATE EXTENSION hstore WITH SCHEMA "app types"; CREATE EXTENSION ltree WITH SCHEMA public`,
			)
			const items = pgTable('items', {
				id: customType<{ data: string }>({ dataType: () => 'citext' })().primaryKey(),
			})
			const definition = compiledDatabase(
				{ schema: { items }, requirements: { extensions: ['citext', 'hstore', 'ltree'] } },
				{
					evolution: 'migrations',
					lineage: 'extensions',
					migrations: [migration(1000, 'CREATE TABLE items (id citext PRIMARY KEY)')],
				},
			)
			@Plugin({ forkable: true })
			class ExtensionOwner extends BasePlugin {
				open() {
					return this.ctx.service(Pg).use(definition)
				}
			}
			lowerTestPlugin(ExtensionOwner)
			await using host = await createTestHost({ services: [pglite(client)] })
			const [owner, fork, another] = await host.start([
				ExtensionOwner.nodeAddress(),
				ExtensionOwner.nodeAddress('tenant'),
				ExtensionOwner.nodeAddress('another'),
			])
			const primary = await owner.open()
			for (const handle of [primary, await fork.open()]) {
				await handle.transaction((tx) => tx.insert(items).values({ id: 'ABC' }))
				expect(
					await handle.read((db) =>
						db
							.select({
								matches: sql<boolean>`${items.id} = 'abc'::citext`,
								value: sql<string>`'key=>value'::hstore -> 'key'`,
								depth: sql<number>`nlevel('one.two'::ltree)`,
							})
							.from(items),
					),
				).toEqual([{ matches: true, value: 'value', depth: 2 }])
			}
			const namespaces = () =>
				client.query<{ name: string; schema: string }>(
					`SELECT e.extname AS name, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
				 WHERE extname IN ('citext','hstore','ltree') ORDER BY e.extname`,
				)
			const installed = await namespaces()
			expect(installed.rows).toEqual([
				{ name: 'citext', schema: 'pluxel_extensions' },
				{ name: 'hstore', schema: 'app types' },
				{ name: 'ltree', schema: 'public' },
			])

			// Reproduce a database where an earlier Host installed citext into its first owner.
			const [row] = await primary.read((db) =>
				db.select({ schema: sql<string>`current_schema()` }).from(items),
			)
			await drizzle(client).execute(
				sql`ALTER EXTENSION citext SET SCHEMA ${sql.identifier(row!.schema)}`,
			)
			await expect(another.open()).rejects.toThrow(/citext.*private schema.*administrator/)
			const unchanged = await namespaces()
			expect(unchanged.rows[0]?.schema).toBe(row!.schema)
		} finally {
			await client.close()
		}
	}, 30_000)

	it('reuses reset data when the schema lineage is unchanged', async () => {
		const initial = resetDatabaseFixture(migrationSql)
		const rebuilt = resetDatabaseFixture(`-- generated by a newer toolchain\n${migrationSql}`)
		const host = databaseHost
		try {
			@Plugin({ displayName: 'ResetDatabasePlugin' })
			class InitialPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof initial.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(initial.database)
					await this.db.transaction((tx) =>
						tx.insert(initial.items).values({ id: 'kept', value: 'same-schema' }),
					)
				}
			}
			lowerTestPlugin(InitialPlugin, { id: 'ResetDatabasePlugin' })
			host.add(InitialPlugin)
			host.cfg(InitialPlugin).setAutoStart(true)
			host.start(InitialPlugin)
			await host.commit()
			const initialInstance = (host.require(InitialPlugin).db as any).instance.instanceId
			host.remove(InitialPlugin)
			await host.commit()

			@Plugin({ displayName: 'ResetDatabasePlugin' })
			class RebuiltPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof rebuilt.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(rebuilt.database)
				}
			}
			lowerTestPlugin(RebuiltPlugin, { id: 'ResetDatabasePlugin' })
			host.add(RebuiltPlugin)
			host.cfg(RebuiltPlugin).setAutoStart(true)
			host.start(RebuiltPlugin)
			await host.commit()
			const next = host.require(RebuiltPlugin).db
			expect((next as any).instance.instanceId).toBe(initialInstance)
			await expect(next.read((db) => db.select().from(rebuilt.items))).resolves.toEqual([
				{ id: 'kept', value: 'same-schema' },
			])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('keeps the previous instance active when a replacement lineage fails', async () => {
		const stable = databaseFixture('stable')
		const invalid = invalidDatabaseFixture('broken-replacement')
		const host = databaseHost
		try {
			@Plugin({ displayName: 'AtomicReplacementPlugin' })
			class StableRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof stable.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(stable.database)
					await this.db.transaction((tx) =>
						tx.insert(stable.items).values({ id: 'kept', value: 'durable' }),
					)
				}
			}
			lowerTestPlugin(StableRelease, { id: 'AtomicReplacementPlugin' })
			host.add(StableRelease)
			host.cfg(StableRelease).setAutoStart(true)
			host.start(StableRelease)
			await host.commit()
			const stableInstance = (host.require(StableRelease).db as any).instance.instanceId
			host.remove(StableRelease)
			await host.commit()

			@Plugin({ displayName: 'AtomicReplacementPlugin' })
			class BrokenRelease extends BasePlugin {
				override async init() {
					await this.ctx.service(Pg).use(invalid.database)
				}
			}
			lowerTestPlugin(BrokenRelease, { id: 'AtomicReplacementPlugin' })
			host.add(BrokenRelease)
			host.cfg(BrokenRelease).setAutoStart(true)
			host.start(BrokenRelease)
			await expect(host.commit()).rejects.toThrow('Some plugins failed to start')
			host.remove(BrokenRelease)
			await host.commit()

			@Plugin({ displayName: 'AtomicReplacementPlugin' })
			class RecoveredRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof stable.database>
				override async init() {
					this.db = await this.ctx.service(Pg).use(stable.database)
				}
			}
			lowerTestPlugin(RecoveredRelease, { id: 'AtomicReplacementPlugin' })
			host.add(RecoveredRelease)
			host.cfg(RecoveredRelease).setAutoStart(true)
			host.start(RecoveredRelease)
			await host.commit()
			const recovered = host.require(RecoveredRelease).db
			expect((recovered as any).instance.instanceId).toBe(stableInstance)
			await expect(recovered.read((db) => db.select().from(stable.items))).resolves.toEqual([
				{ id: 'kept', value: 'durable' },
			])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)
})
