import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pluginNodeAddressOf } from '@pluxel/core'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { asc } from 'drizzle-orm'
import * as v from 'valibot'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	defineDatabase,
	type DatabaseDefinition,
	type PluginDatabaseHandle,
} from '@pluxel/runtime/database'
import type { DatabaseArtifact } from '../../src/database-internal'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { requireWorkbench } from '../../src/services/workbench'
import {
	attachPostgresPoolErrorHandler,
	subscribeDatabaseHandle,
} from '../../src/services/DatabaseService'
import { pluginNodeAddressKey } from '../../src/runtime/plugin-address'
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
	let workbenchDatabaseHost: RuntimeHost

	beforeAll(() => {
		databaseHost = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		workbenchDatabaseHost = createRuntimeHost({
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
	})

	afterAll(() => Promise.all([databaseHost.dispose(), workbenchDatabaseHost.dispose()]))

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
			host.cfg(QueuedDatabasePlugin).enable()
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
			host.cfg(DatabaseLeft).enable()
			host.cfg(DatabaseRight).enable()
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
			host.cfg(DisabledDatabasePlugin).enable()
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
				firstHost.cfg(FirstProcessPlugin).enable()
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
				secondHost.cfg(SecondProcessPlugin).enable()
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
			host.cfg(DefaultPersistenceDatabasePlugin).enable()
			await host.commit()
			expect(host.isRunning(DefaultPersistenceDatabasePlugin)).toBe(true)
		} finally {
			await host.dispose()
			await rm(root, { recursive: true, force: true })
		}
	}, 30_000)

	it('adopts the previous owner-schema layout without losing plugin rows', async () => {
		const definition = databaseFixture('main')
		const ownerId = pluginNodeAddressKey({
			definition: {
				entry: { kind: 'source-entry', source: 'pluxel-test:LegacyDatabasePlugin' },
				exportName: 'Plugin',
			},
			instance: 'default',
		})
		const slug = ownerId
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, '_')
			.replaceAll(/^_+|_+$/g, '')
		const ownerSchema = `pluxel_${slug.slice(0, 36) || 'plugin'}_${createHash('sha256').update(ownerId).digest('hex').slice(0, 16)}`
		const ownerRole = `${ownerSchema}_r`
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-legacy-'))
		const dataDir = join(root, 'pglite')
		try {
			const legacy = new PGlite(dataDir)
			await legacy.waitReady
			await legacy.exec(`
				CREATE SCHEMA pluxel_system;
				CREATE TABLE pluxel_system.plugin_migrations (
					owner_schema text NOT NULL,
					migration_id text NOT NULL,
					checksum text NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (owner_schema, migration_id)
				);
				CREATE ROLE "${ownerRole}" NOLOGIN;
				GRANT "${ownerRole}" TO CURRENT_USER;
				CREATE SCHEMA "${ownerSchema}";
				GRANT USAGE ON SCHEMA "${ownerSchema}" TO "${ownerRole}";
				CREATE TABLE "${ownerSchema}".items (id text PRIMARY KEY, value text NOT NULL);
				GRANT SELECT, INSERT, UPDATE, DELETE ON "${ownerSchema}".items TO "${ownerRole}";
				INSERT INTO "${ownerSchema}".items VALUES ('legacy', 'preserved');
				INSERT INTO pluxel_system.plugin_migrations(owner_schema, migration_id, checksum)
				VALUES ('${ownerSchema}', '0000_initial', '${createHash('sha256').update(migrationSql).digest('hex')}');
			`)
			await legacy.close()

			const host = createRuntimeHost({ workbench: false, database: { driver: 'pglite', dataDir } })
			try {
				@Plugin({ displayName: 'LegacyDatabasePlugin' })
				class LegacyDatabasePlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.database.use(definition.database)
					}
				}
				lowerTestPlugin(LegacyDatabasePlugin)
				host.add(LegacyDatabasePlugin)
				host.cfg(LegacyDatabasePlugin).enable()
				await host.commit()
				await expect(
					host.require(LegacyDatabasePlugin).db.read((db) => db.select().from(definition.items)),
				).resolves.toEqual([{ id: 'legacy', value: 'preserved' }])
			} finally {
				await host.dispose()
			}
		} finally {
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
			host.cfg(InitialPlugin).enable()
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
			host.cfg(UpgradedPlugin).enable()
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
			host.cfg(FirstRelease).enable()
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
			host.cfg(SecondRelease).enable()
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
			host.cfg(InitialPlugin).enable()
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
			host.cfg(RebuiltPlugin).enable()
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
			host.cfg(StableRelease).enable()
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
			host.cfg(BrokenRelease).enable()
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
			host.cfg(RecoveredRelease).enable()
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

	it('projects validated, ordered liveQuery snapshots and revokes them with the owner', async () => {
		const definition = databaseFixture()
		const contract = workbenchContract.define({
			resources: {
				items: workbenchContract.liveQuery({
					row: v.object({ id: v.string(), value: v.string() }),
					key: 'id',
				}),
			},
			views: {
				Test: { placements: [workbenchContract.tab()] },
			},
		})
		const extension = workbench.extension({ contract })
		const host = workbenchDatabaseHost
		try {
			@Plugin({ displayName: 'LiveQueryDatabasePlugin' })
			class LiveQueryDatabasePlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
					await this.db.transaction((tx) =>
						tx.insert(definition.items).values({ id: 'b', value: 'second' }),
					)
					this.ctx.workbench.mount(extension, {
						items: workbench.bind.liveQuery({
							database: this.db,
							dependsOn: [definition.items],
							query: (db) => db.select().from(definition.items).orderBy(asc(definition.items.id)),
						}),
					})
				}
			}

			lowerTestPlugin(LiveQueryDatabasePlugin)
			host.add(LiveQueryDatabasePlugin)
			host.cfg(LiveQueryDatabasePlugin).enable()
			await host.commit()
			const backend = requireWorkbench(host.ctx)
			const grantId = backend.registry.getPluginLayout(pluginNodeAddressOf(LiveQueryDatabasePlugin))
				.items[0]!.model.items!.grantId
			const resourceId = backend.registry.resolveModel(grantId, 'liveQuery').resourceId
			await expect(backend.liveQueries.loadFor(resourceId, undefined)).resolves.toMatchObject({
				revision: 1,
				rows: [{ id: 'b', value: 'second' }],
			})

			await host
				.require(LiveQueryDatabasePlugin)
				.db.transaction((tx) => tx.insert(definition.items).values({ id: 'a', value: 'first' }))
			await expect(backend.liveQueries.loadFor(resourceId, undefined)).resolves.toMatchObject({
				revision: 2,
				rows: [
					{ id: 'a', value: 'first' },
					{ id: 'b', value: 'second' },
				],
			})

			const stoppedHandle = host.require(LiveQueryDatabasePlugin).db
			host.remove(LiveQueryDatabasePlugin)
			await host.commit()
			await expect(stoppedHandle.read((db) => db.select().from(definition.items))).rejects.toThrow(
				'stopped',
			)
			await expect(backend.liveQueries.loadFor(resourceId, undefined)).rejects.toThrow(
				'unavailable',
			)
		} finally {
			await resetRuntimeHost(host)
		}
	}, 30_000)

	it('validates liveQuery params and rejects duplicate projected keys', async () => {
		const definition = databaseFixture()
		const contract = workbenchContract.define({
			resources: {
				items: workbenchContract.liveQuery({
					params: v.object({ search: v.string() }),
					row: v.object({ id: v.string(), value: v.string() }),
					key: 'id',
				}),
			},
			views: {
				Test: { placements: [workbenchContract.tab()] },
			},
		})
		const extension = workbench.extension({ contract })
		const host = workbenchDatabaseHost
		try {
			@Plugin({ displayName: 'ValidatedLiveQueryPlugin' })
			class ValidatedLiveQueryPlugin extends BasePlugin {
				override async init() {
					const database = await this.ctx.database.use(definition.database)
					await database.transaction((tx) =>
						tx.insert(definition.items).values({ id: 'same', value: 'value' }),
					)
					this.ctx.workbench.mount(extension, {
						items: workbench.bind.liveQuery({
							database,
							dependsOn: [definition.items],
							query: async (db) => {
								const rows = await db.select().from(definition.items)
								return [...rows, ...rows]
							},
						}),
					})
				}
			}
			lowerTestPlugin(ValidatedLiveQueryPlugin)
			host.add(ValidatedLiveQueryPlugin)
			host.cfg(ValidatedLiveQueryPlugin).enable()
			await host.commit()
			const backend = requireWorkbench(host.ctx)
			const grantId = backend.registry.getPluginLayout(
				pluginNodeAddressOf(ValidatedLiveQueryPlugin),
			).items[0]!.model.items!.grantId
			const resourceId = backend.registry.resolveModel(grantId, 'liveQuery').resourceId
			await expect(backend.liveQueries.loadFor(resourceId, undefined)).rejects.toThrow(
				'invalid liveQuery params',
			)
			await expect(backend.liveQueries.loadFor(resourceId, { search: '' })).rejects.toThrow(
				'duplicate key',
			)
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
			host.cfg(RollbackDatabasePlugin).enable()
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
