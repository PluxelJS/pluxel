import { createHash } from 'node:crypto'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { Database, database, defineDatabase, type PluginDatabaseHandle } from '../src/database'
import { pglite } from '../src/database/pglite'
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
@Plugin()
class Owner extends BasePlugin {
	async init() {
		handle = await this.ctx.require(Database).use(definition)
	}
}

it('opens the selected backend lazily and drains accepted transactions before Host closes it', async () => {
	let opens = 0
	let closes = 0
	const backend = pglite({ dataDir: 'memory://' })
	const host = await createHost({
		plugins: [Owner],
		services: [
			database({
				backend: async (onError) => {
					opens++
					const adapter = await backend(onError)
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
		await host.startNode(pluginNodeAddressOf(Owner))
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
		await expect(handle.read((db) => db.select().from(items))).rejects.toThrow(
			/stopped|closed|withdrawn|inactive/i,
		)
	} finally {
		release.resolve()
		await host.close()
	}
})
