import { createHash } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { BasePlugin, Plugin } from '@pluxel/core'
import { Sqlite, defineDatabase, type DatabaseDefinition } from '@pluxel/services/sqlite'
import { libsql } from '@pluxel/services/sqlite/libsql'
import { createTestHost } from '@pluxel/test'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { relations, sql } from 'drizzle-orm'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'
import { assert, expect, expectTypeOf, it } from 'vitest'

const parents = sqliteTable('parents', { id: integer().primaryKey() })
const children = sqliteTable('children', {
	id: integer().primaryKey(),
	parentId: integer('parent_id')
		.notNull()
		.references(() => parents.id, { onDelete: 'cascade' }),
})
const schema = {
	parents,
	children,
	parentRelations: relations(parents, ({ many }) => ({ children: many(children) })),
	childRelations: relations(children, ({ one }) => ({
		parent: one(parents, { fields: [children.parentId], references: [parents.id] }),
	})),
}
const baseline = [
	'CREATE TABLE parents (id INTEGER PRIMARY KEY)',
	'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE)',
]

function definition(entries: string[][], lineage = 'main'): DatabaseDefinition<typeof schema> {
	return Reflect.apply(defineDatabase, undefined, [
		{ schema },
		{
			evolution: 'migrations',
			lineage,
			migrations: entries.map((statements, index) => ({
				sql: statements,
				bps: true,
				folderMillis: index + 1,
				hash: createHash('sha256')
					.update(statements.join('--> statement-breakpoint'))
					.digest('hex'),
			})),
		},
	])
}

@Plugin({ forkable: true })
class Store extends BasePlugin {
	open(database: DatabaseDefinition<typeof schema>) {
		return this.ctx.service(Sqlite).use(database)
	}
}

it('binds the native client to each fork and preserves the owner file on reopen', async () => {
	await using directory = await createDiskFixture({})
	await using host = await createTestHost({ services: [libsql({ directory: directory.path })] })
	const address = Store.nodeAddress()
	const [owner, fork] = await host.start([address, Store.nodeAddress('tenant')])
	const initial = definition([baseline])
	const main = await owner.open(initial)
	expect(await owner.open(initial)).toBe(main)

	assert(main.supportsInteractiveTransactions)
	await main.run((db) =>
		db.transaction(async (tx) => {
			await tx.insert(parents).values({ id: 1 })
			await tx.insert(children).values({ id: 7, parentId: 1 })
		}),
	)
	await using peer = await createTestHost({ services: [libsql({ directory: directory.path })] })
	const reader = await peer.start(address)
	const writing = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const write = main.run((db) =>
		db.transaction(async (tx) => {
			await tx.insert(parents).values({ id: 3 })
			writing.resolve()
			await release.promise
			throw new Error('cancel write')
		}),
	)
	await writing.promise
	try {
		const handle = await reader.open(initial)
		expect(await handle.run((db) => db.select().from(parents))).toEqual([{ id: 1 }])
	} finally {
		release.resolve()
		await expect(write).rejects.toThrow('cancel write')
	}
	const related = await main.run((db) => db.query.parents.findMany({ with: { children: true } }))
	expectTypeOf(related).toEqualTypeOf<
		{ id: number; children: { id: number; parentId: number }[] }[]
	>()
	expect(related).toEqual([{ id: 1, children: [{ id: 7, parentId: 1 }] }])
	const branch = await fork.open(initial)
	expect(await branch.run((db) => db.select().from(parents))).toEqual([])
	const batch = await branch.run((db) => {
		expectTypeOf(db).not.toHaveProperty('transaction')
		return db.batch([
			db.insert(parents).values({ id: 2 }).returning(),
			db.insert(children).values({ id: 9, parentId: 2 }).returning(),
		])
	})
	expectTypeOf(batch).toEqualTypeOf<[{ id: number }[], { id: number; parentId: number }[]]>()
	expect(batch).toEqual([[{ id: 2 }], [{ id: 9, parentId: 2 }]])

	await host.stop(address)
	await expect(main.run((db) => db.select().from(parents))).rejects.toThrow(
		/stopped|withdrawn|closed|inactive/i,
	)
	const restarted = await host.start(address)
	const fresh = await restarted.open(definition([baseline], 'new'))
	expect(await fresh.run((db) => db.select().from(parents))).toEqual([])
	await host.stop(address)
	const reopened = await host.start(address)
	const restored = await reopened.open(initial)
	expect(await restored.run((db) => db.select().from(parents))).toEqual([{ id: 1 }])
})

it('retries opening an existing journal while the SQLite file is exclusively locked', async () => {
	await using directory = await createDiskFixture({})
	const provider = libsql({ directory: directory.path })
	await using first = await createTestHost({ services: [provider] })
	await using second = await createTestHost({ services: [provider] })
	const address = Store.nodeAddress()
	const [writer, reader] = await Promise.all([first.start(address), second.start(address)])
	const current = definition([baseline])
	const database = await writer.open(current)
	await database.run((db) => db.run(sql`PRAGMA locking_mode = EXCLUSIVE`))
	await database.run((db) => db.insert(parents).values({ id: 1 }))
	const [reopened] = await Promise.all([
		reader.open(current),
		wait(30).then(() =>
			database.run(async (db) => {
				await db.run(sql`PRAGMA locking_mode = NORMAL`)
				// SQLite releases the exclusive file lock on the next access.
				await db.select().from(parents)
			}),
		),
	])
	expect(await reopened.run((db) => db.select().from(parents))).toEqual([{ id: 1 }])
})

it('rolls back invalid history or foreign keys and applies a concurrent table rebuild once', async () => {
	await using directory = await createDiskFixture({})
	const provider = libsql({ directory: directory.path })
	await using first = await createTestHost({ services: [provider] })
	const address = Store.nodeAddress()
	const owner = await first.start(address)
	const original = await owner.open(definition([baseline]))
	await original.run((db) =>
		db.batch([
			db.insert(parents).values({ id: 1 }),
			db.insert(children).values({ id: 7, parentId: 1 }),
		]),
	)

	await using second = await createTestHost({ services: [provider] })
	await using third = await createTestHost({ services: [provider] })
	const left = await second.start(address)
	const right = await third.start(address)
	await expect(left.open(definition([[...baseline, 'SELECT 1']]))).rejects.toThrow(
		/prefix|history/i,
	)
	await expect(
		left.open(
			definition([
				baseline,
				['CREATE TABLE audit (id INTEGER PRIMARY KEY)', 'INSERT INTO children VALUES (2, 9999)'],
			]),
		),
	).rejects.toThrow(/foreign key/i)

	const rebuild = definition([
		baseline,
		[
			'PRAGMA foreign_keys=OFF',
			'CREATE TABLE __new_parents (id INTEGER PRIMARY KEY, name TEXT)',
			'INSERT INTO __new_parents(id) SELECT id FROM parents',
			'DROP TABLE parents',
			'ALTER TABLE __new_parents RENAME TO parents',
			'PRAGMA foreign_keys=ON',
			'CREATE TABLE audit (id INTEGER PRIMARY KEY)',
			'INSERT INTO audit VALUES (1)',
		],
	])
	const locked = Promise.withResolvers<void>()
	assert(original.supportsInteractiveTransactions)
	const writer = original.run((db) =>
		db.transaction(async () => {
			locked.resolve()
			await wait(50)
		}),
	)
	await locked.promise
	const [db, peer] = await Promise.all([left.open(rebuild), right.open(rebuild), writer])
	expect(await db.run((q) => q.select().from(children))).toEqual([{ id: 7, parentId: 1 }])
	expect(await peer.run((q) => q.all(sql`SELECT * FROM audit`))).toEqual([{ id: 1 }])
	await expect(
		db.run((q) => q.insert(children).values({ id: 2, parentId: 9999 })),
	).rejects.toMatchObject({ cause: { extendedCode: 'SQLITE_CONSTRAINT_FOREIGNKEY' } })
})
