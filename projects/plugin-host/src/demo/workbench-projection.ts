import { asc, eq } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import {
	defineDatabase,
	type PluginDatabaseClient,
	type PluginDatabaseHandle,
} from '@pluxel/runtime/database'

export const demoProjections = pgTable(
	'demo_projections',
	{
		resource: text('resource').notNull(),
		id: text('id').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
		position: integer('position').notNull(),
		updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.resource, table.id] }),
		index('demo_projections_resource_position_idx').on(table.resource, table.position),
	],
)

export const demoDatabase = defineDatabase({
	schema: { demoProjections },
	evolution: 'reset-on-schema-change',
})

type Item = Readonly<{ id: string }>

export class DemoProjectionStore {
	constructor(readonly database: PluginDatabaseHandle<typeof demoDatabase>) {}

	async replaceAll<T extends Item>(resource: string, items: readonly T[]): Promise<void> {
		await this.database.transaction(async (tx) => {
			await tx.delete(demoProjections).where(eq(demoProjections.resource, resource))
			if (items.length === 0) return
			await tx.insert(demoProjections).values(
				items.map((item, position) => ({
					resource,
					id: item.id,
					payload: item,
					position,
					updatedAt: Date.now(),
				})),
			)
		})
	}
}

export function demoProjectionQuery<T extends Item>(resource: string) {
	return async (db: PluginDatabaseClient<typeof demoDatabase>): Promise<T[]> => {
		const rows = await db
			.select({ payload: demoProjections.payload })
			.from(demoProjections)
			.where(eq(demoProjections.resource, resource))
			.orderBy(asc(demoProjections.position), asc(demoProjections.id))
		return rows.map(({ payload }) => payload as T)
	}
}
