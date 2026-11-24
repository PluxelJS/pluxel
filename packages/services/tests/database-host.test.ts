import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { Pg, defineDatabase, type PluginDatabaseHandle } from '@pluxel/services/pg'
import { pglite } from '@pluxel/services/pg/pglite'
import { postgres } from '@pluxel/services/pg/postgres'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { expect, it, vi } from 'vitest'
import type { DatabaseArtifact } from '../src/database/artifact'

const items = pgTable('items', { id: text('id').primaryKey() })
const migration = 'CREATE TABLE items (id text PRIMARY KEY)'
const artifact: DatabaseArtifact = {
	evolution: 'migrations',
	lineage: 'host',
	migrations: [
		{
			id: '0000',
			sql: migration,
			checksum: createHash('sha256').update(migration).digest('hex'),
		},
	],
}
const definition = (defineDatabase as Function)({ schema: { items } }, artifact) as ReturnType<
	typeof defineDatabase<{ items: typeof items }>
>
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
