import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import {
	Pg,
	defineDatabase,
	type DatabaseDefinition,
	type PluginDatabaseHandle,
} from '@pluxel/services/pg'
import { pglite } from '@pluxel/services/pg/pglite'
import { postgres } from '@pluxel/services/pg/postgres'
import { Sqlite, defineDatabase as defineSqliteDatabase } from '@pluxel/services/sqlite'
import { d1 } from '@pluxel/services/sqlite/d1'
import { createTestHost } from '@pluxel/test'
import { relations } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { expect, expectTypeOf, it, vi } from 'vitest'
import type { DatabaseArtifact } from '../src/database/artifact'

const items = pgTable('items', { id: text('id').primaryKey() })
const labels = pgTable('labels', {
	id: text('id').primaryKey(),
	itemId: text('item_id')
		.notNull()
		.references(() => items.id),
})
const itemRelations = relations(items, ({ many }) => ({ labels: many(labels) }))
const labelRelations = relations(labels, ({ one }) => ({
	item: one(items, { fields: [labels.itemId], references: [items.id] }),
}))
const statements = [
	'CREATE TABLE items (id text PRIMARY KEY)',
	'CREATE TABLE labels (id text PRIMARY KEY, item_id text NOT NULL REFERENCES items(id))',
]
const artifact: DatabaseArtifact = {
	evolution: 'migrations',
	lineage: 'host',
	migrations: [
		{
			folderMillis: 1000,
			bps: true,
			sql: statements,
			hash: createHash('sha256').update(statements.join('--> statement-breakpoint')).digest('hex'),
		},
	],
}
function compiledDatabase<Schema extends Record<string, unknown>>(
	schema: Schema,
): DatabaseDefinition<Schema> {
	return Reflect.apply(defineDatabase, undefined, [
		{ schema },
		artifact,
	]) as DatabaseDefinition<Schema>
}
const definition = compiledDatabase({ items, labels, itemRelations, labelRelations })
let handle!: PluginDatabaseHandle<typeof definition>
// PGlite cold-start includes WASM compilation; this test measures draining, not startup latency.
@Plugin({ startTimeoutMs: 15_000 })
class Owner extends BasePlugin {
	async init() {
		handle = await this.ctx.service(Pg).use(definition)
	}
}

let pg!: Pg
@Plugin()
class DeferredOwner extends BasePlugin {
	override init() {
		pg = this.ctx.service(Pg)
	}

	get sqlite() {
		return this.ctx.service(Sqlite)
	}
}

it.each(['owned', 'borrowed'] as const)(
	'opens the %s backend lazily and drains accepted transactions before Host releases it',
	async (ownership) => {
		const close = vi.fn(async () => {})
		const setup = vi.fn(async () => ({ close }))
		const options = { extensions: { probe: { name: 'probe', setup } } }
		const borrowedClient = ownership === 'borrowed' ? await PGlite.create(options) : undefined
		const host = await createHost({
			plugins: [{ plugin: Owner }],
			services: [pglite(borrowedClient ?? options)],
		})
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		try {
			expect(setup).toHaveBeenCalledTimes(ownership === 'owned' ? 0 : 1)
			const started = await host.startNode(Owner.nodeAddress())
			expect(started.core).toMatchObject({
				status: 'committed',
				summary: { lifecycleReport: { ok: true } },
			})
			expect(setup).toHaveBeenCalledOnce()
			const operation = handle.transaction(async (tx) => {
				await tx.insert(items).values({ id: 'before-close' })
				entered.resolve()
				await release.promise
				return await tx.select().from(items)
			})
			await entered.promise
			const closing = host.close()
			expect(close).not.toHaveBeenCalled()
			release.resolve()
			await expect(operation).resolves.toEqual([{ id: 'before-close' }])
			await closing
			expect(close).toHaveBeenCalledTimes(ownership === 'owned' ? 1 : 0)
			const nativeRead = await borrowedClient?.query('select 1 as answer')
			expect(nativeRead?.rows ?? []).toEqual(ownership === 'borrowed' ? [{ answer: 1 }] : [])
			await expect(handle.read((db) => db.select().from(items))).rejects.toThrow(
				/stopped|closed|withdrawn|inactive/i,
			)
		} finally {
			release.resolve()
			await host.close()
			await borrowedClient?.close()
		}
	},
	30_000,
)

it('rejects installing both providers for Pg', async () => {
	await expect(createHost({ services: [pglite(), postgres()] })).rejects.toMatchObject({
		code: 'DUPLICATE_SERVICE',
	})
})

it('requires a Drizzle release before either service opens a database', async () => {
	await using host = await createTestHost({ services: [pglite(), d1({})] })
	const { sqlite } = await host.start(DeferredOwner.nodeAddress())
	// Plain evaluation is how Drizzle Kit discovers tables before generating the release.
	await expect(pg.use(Reflect.apply(defineDatabase, undefined, [{ schema: {} }]))).rejects.toThrow(
		'compiled postgresql',
	)
	await expect(
		sqlite.use(Reflect.apply(defineSqliteDatabase, undefined, [{ schema: {} }])),
	).rejects.toThrow('compiled sqlite')
	// @ts-expect-error PostgreSQL and SQLite definitions belong to different services.
	await expect(sqlite.use(definition)).rejects.toThrow('compiled sqlite')
})

it('queries declared tables and relations in each owner read and transaction callback', async () => {
	const host = await createHost({
		plugins: [{ plugin: Owner }, { plugin: DeferredOwner }],
		services: [pglite()],
	})
	try {
		await host.startNode(Owner.nodeAddress())
		await host.startNode(DeferredOwner.nodeAddress())
		const other = await pg.use(
			compiledDatabase({ inventory: items, labels, itemRelations, labelRelations }),
		)
		await handle.transaction(async (tx) => {
			await tx.insert(items).values({ id: 'left' })
			await tx.insert(labels).values({ id: 'tag', itemId: 'left' })
		})
		const left = await handle.read((db) => db.query.items.findMany({ with: { labels: true } }))
		expectTypeOf(left).toEqualTypeOf<{ id: string; labels: { id: string; itemId: string }[] }[]>()
		expect(left).toEqual([{ id: 'left', labels: [{ id: 'tag', itemId: 'left' }] }])

		const right = await other.transaction(async (tx) => {
			await tx.insert(items).values({ id: 'right' })
			return tx.query.inventory.findMany({ with: { labels: true } })
		})
		expectTypeOf(right).toEqualTypeOf<typeof left>()
		expect(right).toEqual([{ id: 'right', labels: [] }])
		expect(await handle.read((db) => db.query.items.findMany())).toEqual([{ id: 'left' }])
	} finally {
		await host.close()
	}
}, 30_000)

it.each(['driver', 'metadata'] as const)(
	'allows another use after a transient %s initialization failure in the same Host',
	async (stage) => {
		const failure = new Error('temporary initialization failure')
		const setup = vi.fn(async () => ({})).mockRejectedValueOnce(failure)
		const client = stage === 'metadata' ? await PGlite.create() : undefined
		if (client) vi.spyOn(client, 'query').mockRejectedValueOnce(failure)
		const host = await createHost({
			plugins: [{ plugin: DeferredOwner }],
			services: [pglite(client ?? { extensions: { probe: { name: 'probe', setup } } })],
		})
		try {
			await host.startNode(DeferredOwner.nodeAddress())
			const failures = await Promise.allSettled([pg.use(definition), pg.use(definition)])
			expect(failures).toEqual([
				{ status: 'rejected', reason: expect.objectContaining({ cause: failure }) },
				{ status: 'rejected', reason: expect.objectContaining({ cause: failure }) },
			])
			const database = await pg.use(definition)
			expect(await database.read((db) => db.select().from(items))).toEqual([])
			expect(setup).toHaveBeenCalledTimes(stage === 'driver' ? 2 : 0)
		} finally {
			await host.close()
			await client?.close()
		}
	},
	30_000,
)
