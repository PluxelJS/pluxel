import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { asc } from 'drizzle-orm'
import * as v from 'valibot'
import { describe, expect, it, vi } from 'vitest'
import {
	defineDatabase,
	type DatabaseDefinition,
	type PluginDatabaseHandle,
} from '@pluxel/runtime/database'
import type { DatabaseArtifact } from '../../src/database-internal'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { requireWorkbench } from '../../src/services/workbench'
import { subscribeDatabaseHandle } from '../../src/services/DatabaseService'

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

describe('DatabaseService', () => {
	it('runs migrations and isolates same-named tables by canonical plugin owner', async () => {
		const definition = databaseFixture()
		const host = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'DatabaseLeft' })
			class DatabaseLeft extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
					await this.db.transaction((tx) =>
						tx.insert(definition.items).values({ id: 'item', value: 'left' }),
					)
				}
			}

			@Plugin({ name: 'DatabaseRight' })
			class DatabaseRight extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
					await this.db.transaction((tx) =>
						tx.insert(definition.items).values({ id: 'item', value: 'right' }),
					)
				}
			}

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
			await host.dispose()
		}
	}, 30_000)

	it('fails honestly when the host disables database capability', async () => {
		const definition = databaseFixture()
		const host = createRuntimeHost({ workbench: false, database: false })
		try {
			@Plugin({ name: 'DisabledDatabasePlugin' })
			class DisabledDatabasePlugin extends BasePlugin {
				override async init() {
					await this.ctx.database.use(definition.database)
				}
			}
			host.add(DisabledDatabasePlugin)
			host.cfg(DisabledDatabasePlugin).enable()
			await expect(host.commit()).rejects.toThrow('DisabledDatabasePlugin')
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
				@Plugin({ name: 'PersistentDatabasePlugin' })
				class FirstProcessPlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.database.use(definition.database)
						await this.db.transaction((tx) =>
							tx.insert(definition.items).values({ id: 'kept', value: 'persisted' }),
						)
					}
				}
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
				@Plugin({ name: 'PersistentDatabasePlugin' })
				class SecondProcessPlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.database.use(definition.database)
					}
				}
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

	it('adopts the previous owner-schema layout without losing plugin rows', async () => {
		const definition = databaseFixture('main')
		const ownerId = 'LegacyDatabasePlugin'
		const slug = ownerId.toLowerCase()
		const ownerSchema = `pluxel_${slug}_${createHash('sha256').update(ownerId).digest('hex').slice(0, 16)}`
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
				@Plugin({ name: 'LegacyDatabasePlugin' })
				class LegacyDatabasePlugin extends BasePlugin {
					db!: PluginDatabaseHandle<typeof definition.database>
					override async init() {
						this.db = await this.ctx.database.use(definition.database)
					}
				}
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
		const host = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'IncrementalDatabasePlugin' })
			class InitialPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof initial.database>
				override async init() {
					this.db = await this.ctx.database.use(initial.database)
					await this.db.transaction((tx) =>
						tx.insert(initial.items).values({ id: 'kept', value: 'before' }),
					)
				}
			}
			host.add(InitialPlugin)
			host.cfg(InitialPlugin).enable()
			await host.commit()
			const initialInstance = (host.require(InitialPlugin).db as any).instance.instanceId
			host.remove(InitialPlugin)
			await host.commit()

			@Plugin({ name: 'IncrementalDatabasePlugin' })
			class UpgradedPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof upgraded.database>
				override async init() {
					this.db = await this.ctx.database.use(upgraded.database)
				}
			}
			host.add(UpgradedPlugin)
			host.cfg(UpgradedPlugin).enable()
			await host.commit()
			const next = host.require(UpgradedPlugin).db
			expect((next as any).instance.instanceId).toBe(initialInstance)
			await expect(next.read((db) => db.select().from(upgraded.items))).resolves.toEqual([
				{ id: 'kept', value: 'before-migrated', tag: 'legacy' },
			])
		} finally {
			await host.dispose()
		}
	}, 30_000)

	it('activates a fresh instance when the plugin changes lineage', async () => {
		const first = databaseFixture('release-a')
		const second = databaseFixture('release-b')
		const host = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'RebasedDatabasePlugin' })
			class FirstRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof first.database>
				override async init() {
					this.db = await this.ctx.database.use(first.database)
					await this.db.transaction((tx) =>
						tx.insert(first.items).values({ id: 'old', value: 'archived' }),
					)
				}
			}
			host.add(FirstRelease)
			host.cfg(FirstRelease).enable()
			await host.commit()
			const firstInstance = (host.require(FirstRelease).db as any).instance.instanceId
			host.remove(FirstRelease)
			await host.commit()

			@Plugin({ name: 'RebasedDatabasePlugin' })
			class SecondRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof second.database>
				override async init() {
					this.db = await this.ctx.database.use(second.database)
				}
			}
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
			await host.dispose()
		}
	}, 30_000)

	it('reuses reset data when the schema lineage is unchanged', async () => {
		const initial = resetDatabaseFixture(migrationSql)
		const rebuilt = resetDatabaseFixture(`-- generated by a newer toolchain\n${migrationSql}`)
		const host = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'ResetDatabasePlugin' })
			class InitialPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof initial.database>
				override async init() {
					this.db = await this.ctx.database.use(initial.database)
					await this.db.transaction((tx) =>
						tx.insert(initial.items).values({ id: 'kept', value: 'same-schema' }),
					)
				}
			}
			host.add(InitialPlugin)
			host.cfg(InitialPlugin).enable()
			await host.commit()
			const initialInstance = (host.require(InitialPlugin).db as any).instance.instanceId
			host.remove(InitialPlugin)
			await host.commit()

			@Plugin({ name: 'ResetDatabasePlugin' })
			class RebuiltPlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof rebuilt.database>
				override async init() {
					this.db = await this.ctx.database.use(rebuilt.database)
				}
			}
			host.add(RebuiltPlugin)
			host.cfg(RebuiltPlugin).enable()
			await host.commit()
			const next = host.require(RebuiltPlugin).db
			expect((next as any).instance.instanceId).toBe(initialInstance)
			await expect(next.read((db) => db.select().from(rebuilt.items))).resolves.toEqual([
				{ id: 'kept', value: 'same-schema' },
			])
		} finally {
			await host.dispose()
		}
	}, 30_000)

	it('keeps the previous instance active when a replacement lineage fails', async () => {
		const stable = databaseFixture('stable')
		const invalid = invalidDatabaseFixture('broken-replacement')
		const host = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'AtomicReplacementPlugin' })
			class StableRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof stable.database>
				override async init() {
					this.db = await this.ctx.database.use(stable.database)
					await this.db.transaction((tx) =>
						tx.insert(stable.items).values({ id: 'kept', value: 'durable' }),
					)
				}
			}
			host.add(StableRelease)
			host.cfg(StableRelease).enable()
			await host.commit()
			const stableInstance = (host.require(StableRelease).db as any).instance.instanceId
			host.remove(StableRelease)
			await host.commit()

			@Plugin({ name: 'AtomicReplacementPlugin' })
			class BrokenRelease extends BasePlugin {
				override async init() {
					await this.ctx.database.use(invalid.database)
				}
			}
			host.add(BrokenRelease)
			host.cfg(BrokenRelease).enable()
			await expect(host.commit()).rejects.toThrow('AtomicReplacementPlugin')
			host.remove(BrokenRelease)
			await host.commit()

			@Plugin({ name: 'AtomicReplacementPlugin' })
			class RecoveredRelease extends BasePlugin {
				db!: PluginDatabaseHandle<typeof stable.database>
				override async init() {
					this.db = await this.ctx.database.use(stable.database)
				}
			}
			host.add(RecoveredRelease)
			host.cfg(RecoveredRelease).enable()
			await host.commit()
			const recovered = host.require(RecoveredRelease).db
			expect((recovered as any).instance.instanceId).toBe(stableInstance)
			await expect(recovered.read((db) => db.select().from(stable.items))).resolves.toEqual([
				{ id: 'kept', value: 'durable' },
			])
		} finally {
			await host.dispose()
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
		})
		const extension = workbench.extension({ contract })
		const host = createRuntimeHost({
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'LiveQueryDatabasePlugin' })
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

			host.add(LiveQueryDatabasePlugin)
			host.cfg(LiveQueryDatabasePlugin).enable()
			await host.commit()
			const backend = requireWorkbench(host.ctx)
			await expect(
				backend.liveQueries.loadFor('LiveQueryDatabasePlugin', 'items', undefined),
			).resolves.toMatchObject({ revision: 1, rows: [{ id: 'b', value: 'second' }] })

			await host
				.require(LiveQueryDatabasePlugin)
				.db.transaction((tx) => tx.insert(definition.items).values({ id: 'a', value: 'first' }))
			await expect(
				backend.liveQueries.loadFor('LiveQueryDatabasePlugin', 'items', undefined),
			).resolves.toMatchObject({
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
			await expect(
				backend.liveQueries.loadFor('LiveQueryDatabasePlugin', 'items', undefined),
			).rejects.toThrow('unavailable')
		} finally {
			await host.dispose()
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
		})
		const extension = workbench.extension({ contract })
		const host = createRuntimeHost({ database: { driver: 'pglite', dataDir: 'memory://' } })
		try {
			@Plugin({ name: 'ValidatedLiveQueryPlugin' })
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
			host.add(ValidatedLiveQueryPlugin)
			host.cfg(ValidatedLiveQueryPlugin).enable()
			await host.commit()
			const backend = requireWorkbench(host.ctx)
			await expect(
				backend.liveQueries.loadFor('ValidatedLiveQueryPlugin', 'items', undefined),
			).rejects.toThrow('invalid liveQuery params')
			await expect(
				backend.liveQueries.loadFor('ValidatedLiveQueryPlugin', 'items', { search: '' }),
			).rejects.toThrow('duplicate key')
		} finally {
			await host.dispose()
		}
	}, 30_000)

	it('does not publish outbox invalidation for rolled-back transactions', async () => {
		const definition = databaseFixture()
		const host = createRuntimeHost({
			workbench: false,
			database: { driver: 'pglite', dataDir: 'memory://' },
		})
		try {
			@Plugin({ name: 'RollbackDatabasePlugin' })
			class RollbackDatabasePlugin extends BasePlugin {
				db!: PluginDatabaseHandle<typeof definition.database>
				override async init() {
					this.db = await this.ctx.database.use(definition.database)
				}
			}
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
			await host.dispose()
		}
	}, 30_000)
})
