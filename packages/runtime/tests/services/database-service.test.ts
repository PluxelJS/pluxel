import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	defineDatabase,
	type DatabaseDefinition,
	type PluginDatabaseHandle,
} from '@pluxel/runtime/database'
import type { DatabaseArtifact } from '../../src/database-internal'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import {
	attachPostgresPoolErrorHandler,
	subscribeDatabaseHandle,
} from '../../src/services/DatabaseService'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const migrationSql = `
	CREATE TABLE items (
		id text PRIMARY KEY,
		value text NOT NULL
	)
`.trim()

const addTagMigrationSql = `
	ALTER TABLE items ADD COLUMN tag text NOT NULL DEFAULT 'legacy';
	UPDATE items SET value = value || '-migrated'
`.trim()

function databaseFixture(lineage = 'main') {
	const items = pgTable('items', {
		id: text('id').primaryKey(),
		value: text('value').notNull(),
	})
	const artifact: DatabaseArtifact = {
		evolution: 'migrations',
		lineage,
		migrations: [
			{
				id: '0000_initial',
				checksum: createHash('sha256').update(migrationSql).digest('hex'),
				sql: migrationSql,
			},
		],
	}
	return {
		items,
		// Production builds inject the validated artifact; tests exercise the same hidden runtime path.
		database: (
			defineDatabase as unknown as (
				input: { schema: { items: typeof items } },
				artifact: DatabaseArtifact,
			) => DatabaseDefinition<{ items: typeof items }>
		)({ schema: { items } }, artifact),
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
		migrations: [
			{
				id: '0000_initial',
				checksum: createHash('sha256').update(migrationSql).digest('hex'),
				sql: migrationSql,
			},
			{
				id: '0001_add_tag',
				checksum: createHash('sha256').update(addTagMigrationSql).digest('hex'),
				sql: addTagMigrationSql,
			},
		],
	}
	return {
		items,
		database: (
			defineDatabase as unknown as (
				input: { schema: { items: typeof items } },
				artifact: DatabaseArtifact,
			) => DatabaseDefinition<{ items: typeof items }>
		)({ schema: { items } }, artifact),
	}
}

function invalidDatabaseFixture(lineage: string) {
	const items = pgTable('items', {
		id: text('id').primaryKey(),
		value: text('value').notNull(),
	})
	const invalidSql = `${migrationSql};\nSELECT * FROM migration_table_that_does_not_exist`
	const artifact: DatabaseArtifact = {
		evolution: 'migrations',
		lineage,
		migrations: [
			{
				id: '0000_invalid',
				checksum: createHash('sha256').update(invalidSql).digest('hex'),
				sql: invalidSql,
			},
		],
	}
	return {
		items,
		database: (
			defineDatabase as unknown as (
				input: { schema: { items: typeof items } },
				artifact: DatabaseArtifact,
			) => DatabaseDefinition<{ items: typeof items }>
		)({ schema: { items } }, artifact),
	}
}

function resetDatabaseFixture(sql: string) {
	const items = pgTable('items', {
		id: text('id').primaryKey(),
		value: text('value').notNull(),
	})
	const artifact: DatabaseArtifact = {
		evolution: 'reset-on-schema-change',
		lineage: 'reset-stable-schema',
		migrations: [
			{
				id: '0000_baseline',
				checksum: createHash('sha256').update(sql).digest('hex'),
				sql,
			},
		],
	}
	return {
		items,
		database: (
			defineDatabase as unknown as (
				input: {
					schema: { items: typeof items }
					evolution: 'reset-on-schema-change'
				},
				artifact: DatabaseArtifact,
			) => DatabaseDefinition<{ items: typeof items }>
		)({ schema: { items }, evolution: 'reset-on-schema-change' }, artifact),
	}
}

async function resetRuntimeHost(host: RuntimeHost): Promise<void> {
	const plugins = host.plugins()
	if (plugins.length === 0) return
	host.remove(plugins)
	await host.commit()
}

describe('DatabaseService', () => {
	let databaseHost: RuntimeHost

	beforeAll(() => {
		databaseHost = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
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
					this.db = await this.ctx.database.use(definition.database)
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
			await runningOperation?.catch(() => undefined)
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
					this.db = await this.ctx.database.use(definition.database)
				}
			}

			lowerTestPlugin(CachedDatabaseHandlePlugin)
			host.add(CachedDatabaseHandlePlugin)
			host.cfg(CachedDatabaseHandlePlugin).setAutoStart(true)
			host.start(CachedDatabaseHandlePlugin)
			await host.commit()
			const database = host.require(CachedDatabaseHandlePlugin).db

			host.remove(CachedDatabaseHandlePlugin)
			await host.commit()

			await expect(database.read((db) => db.select().from(definition.items))).rejects.toThrow(
				'database handle owner has stopped',
			)
			expect(() => subscribeDatabaseHandle(database, [definition.items], () => undefined)).toThrow(
				'database handle owner has stopped',
			)
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('runs migrations and isolates same-named tables by canonical plugin owner', async () => {
		const definition = databaseFixture()
		const host = databaseHost
		try {
			@Plugin({ displayName: 'DatabaseLeft' })
			class DatabaseLeft extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
					await this.db.transaction((tx) =>
						tx.insert(definition.items).values({ id: 'item', value: 'left' }),
					)
				}
			}

			@Plugin({ displayName: 'DatabaseRight' })
			class DatabaseRight extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
					await this.db.transaction((tx) =>
						tx.insert(definition.items).values({ id: 'item', value: 'right' }),
					)
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

			await expect(
				host.require(DatabaseLeft).db.read((db) => db.select().from(definition.items)),
			).resolves.toEqual([{ id: 'item', value: 'left' }])
			await expect(
				host.require(DatabaseRight).db.read((db) => db.select().from(definition.items)),
			).resolves.toEqual([{ id: 'item', value: 'right' }])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('fails honestly when the host disables database capability', async () => {
		const definition = databaseFixture()
		const host = createRuntimeHost({ workbench: false, database: false })
		try {
			@Plugin({ displayName: 'DisabledDatabasePlugin' })
			class DisabledDatabasePlugin extends BasePlugin {
				override async init() {
					await this.ctx.database.use(definition.database)
				}
			}
			lowerTestPlugin(DisabledDatabasePlugin)
			host.add(DisabledDatabasePlugin)
			host.cfg(DisabledDatabasePlugin).setAutoStart(true)
			host.start(DisabledDatabasePlugin)
			await expect(host.commit()).rejects.toThrow('Some plugins failed to start')
			expect(host.isRunning(DisabledDatabasePlugin)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('reuses persisted PGlite instance metadata on a clean root restart', async () => {
		const definition = databaseFixture('persistent')
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-instance-'))
		const dataDir = join(root, 'pglite')
		let instanceId: string
		try {
			const firstHost = createRuntimeHost({
				workbench: false,
				database: { driver: 'pglite', dataDir },
			})
			try {
				@Plugin({ displayName: 'PersistentDatabasePlugin' })
				class FirstProcessPlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.database.use(definition.database)
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
			} finally {
				await firstHost.dispose()
			}

			const secondHost = createRuntimeHost({
				workbench: false,
				database: { driver: 'pglite', dataDir },
			})
			try {
				@Plugin({ displayName: 'PersistentDatabasePlugin' })
				class SecondProcessPlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.database.use(definition.database)
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
				await secondHost.dispose()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 30_000)

	it('creates the default PGlite parent under a new persistence root', async () => {
		const definition = databaseFixture('default-persistence')
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-default-'))
		const persistence = join(root, 'nested', 'persistence')
		const host = createRuntimeHost({ workbench: false, persistence })
		try {
			@Plugin({ displayName: 'DefaultPersistenceDatabasePlugin' })
			class DefaultPersistenceDatabasePlugin extends BasePlugin {
				override async init() {
					await this.ctx.database.use(definition.database)
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
					this.db = await this.ctx.database.use(initial.database)
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
				db!: PluginDatabaseHandle<typeof upgraded.database>
				override async init() {
					this.db = await this.ctx.database.use(upgraded.database)
				}
			}
			lowerTestPlugin(UpgradedPlugin, { id: 'IncrementalDatabasePlugin' })
			host.add(UpgradedPlugin)
			host.cfg(UpgradedPlugin).setAutoStart(true)
			host.start(UpgradedPlugin)
			await host.commit()
			const next = host.require(UpgradedPlugin).db
			expect((next as any).instance.instanceId).toBe(initialInstance)
			await expect(next.read((db) => db.select().from(upgraded.items))).resolves.toEqual([
				{ id: 'kept', value: 'before-migrated', tag: 'legacy' },
			])
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('activates a fresh instance when the plugin changes lineage', async () => {
		const first = databaseFixture('release-a')
		const second = databaseFixture('release-b')
		const host = databaseHost
		try {
			@Plugin({ displayName: 'RebasedDatabasePlugin' })
			class FirstRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof first.database>
				override async init() {
					this.db = await this.ctx.database.use(first.database)
					await this.db.transaction((tx) =>
						tx.insert(first.items).values({ id: 'old', value: 'archived' }),
					)
				}
			}
			lowerTestPlugin(FirstRelease, { id: 'RebasedDatabasePlugin' })
			host.add(FirstRelease)
			host.cfg(FirstRelease).setAutoStart(true)
			host.start(FirstRelease)
			await host.commit()
			const firstInstance = (host.require(FirstRelease).db as any).instance.instanceId
			host.remove(FirstRelease)
			await host.commit()

			@Plugin({ displayName: 'RebasedDatabasePlugin' })
			class SecondRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof second.database>
				override async init() {
					this.db = await this.ctx.database.use(second.database)
				}
			}
			lowerTestPlugin(SecondRelease, { id: 'RebasedDatabasePlugin' })
			host.add(SecondRelease)
			host.cfg(SecondRelease).setAutoStart(true)
			host.start(SecondRelease)
			await host.commit()
			const next = host.require(SecondRelease).db
			expect((next as any).instance.instanceId).not.toBe(firstInstance)
			await expect(next.read((db) => db.select().from(second.items))).resolves.toEqual([])
			await expect(
				next.transaction((tx) => tx.insert(second.items).values({ id: 'new', value: 'active' })),
			).resolves.toBeDefined()
		} finally {
			await resetRuntimeHost(host)
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
					this.db = await this.ctx.database.use(initial.database)
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
					this.db = await this.ctx.database.use(rebuilt.database)
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
					this.db = await this.ctx.database.use(stable.database)
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
					await this.ctx.database.use(invalid.database)
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
					this.db = await this.ctx.database.use(stable.database)
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

	it('does not publish outbox invalidation for rolled-back transactions', async () => {
		const definition = databaseFixture()
		const host = databaseHost
		try {
			@Plugin({ displayName: 'RollbackDatabasePlugin' })
			class RollbackDatabasePlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
				}
			}
			lowerTestPlugin(RollbackDatabasePlugin)
			host.add(RollbackDatabasePlugin)
			host.cfg(RollbackDatabasePlugin).setAutoStart(true)
			host.start(RollbackDatabasePlugin)
			await host.commit()
			const database = host.require(RollbackDatabasePlugin).db
			const listener = vi.fn()
			const unsubscribe = subscribeDatabaseHandle(database, [definition.items], listener)
			await expect(
				database.transaction(async (tx) => {
					await tx.insert(definition.items).values({ id: 'rolled-back', value: 'no' })
					throw new Error('rollback')
				}),
			).rejects.toThrow('rollback')
			await new Promise((resolve) => setTimeout(resolve, 750))
			expect(listener).not.toHaveBeenCalled()
			await expect(database.read((db) => db.select().from(definition.items))).resolves.toEqual([])
			unsubscribe()
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)
})
