import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import {
	Database,
	database,
	defineDatabase,
	type PluginDatabaseHandle,
} from '@pluxel/services/database'
import { pglite } from '@pluxel/services/database/pglite'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
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
		handle = await this.ctx.require(Database).use(definition)
	}
}

it.each(['owned', 'borrowed'] as const)(
	'opens the %s backend lazily and drains accepted transactions before Host releases it',
	async (ownership) => {
		let opens = 0
		let closes = 0
		const borrowedClient = ownership === 'borrowed' ? await PGlite.create() : undefined
		let nativeClient: PGlite | undefined
		const backend = pglite(borrowedClient ?? { dataDir: 'memory://' })
		const host = await createHost({
			plugins: [Owner],
			services: [
				database({
					backend: async (onError) => {
						opens++
						const adapter = await backend(onError)
						nativeClient = Reflect.get(adapter.db, '$client') as PGlite
						return {
							...adapter,
							async close() {
								closes++
								await adapter.close()
							},
						}
					},
				}),
			],
		})
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		try {
			expect(opens).toBe(0)
			const started = await host.startNode(pluginNodeAddressOf(Owner))
			expect(started.core).toMatchObject({
				status: 'committed',
				summary: { lifecycleReport: { ok: true } },
			})
			expect(opens).toBe(1)
			const operation = handle.transaction(async (tx) => {
				await tx.insert(items).values({ id: 'before-close' })
				entered.resolve()
				await release.promise
				return await tx.select().from(items)
			})
			await entered.promise
			const closing = host.close()
			expect(closes).toBe(0)
			release.resolve()
			await expect(operation).resolves.toEqual([{ id: 'before-close' }])
			await closing
			expect(closes).toBe(1)
			expect(nativeClient?.closed).toBe(ownership === 'owned')
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
