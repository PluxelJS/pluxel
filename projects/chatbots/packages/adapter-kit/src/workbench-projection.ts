import { and, asc, eq } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import {
	defineDatabase,
	type PluginDatabaseClient,
	type PluginDatabaseHandle,
} from '@pluxel/runtime/database'

export const workbenchProjections = pgTable(
	'workbench_projections',
	{
		resource: text('resource').notNull(),
		id: text('id').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
		position: integer('position').notNull(),
		updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.resource, table.id] }),
		index('workbench_projections_resource_position_idx').on(table.resource, table.position),
	],
)

export const workbenchProjectionDatabase = defineDatabase({
	schema: { workbenchProjections },
	evolution: 'reset-on-schema-change',
})

type ProjectionItem = Readonly<{ id: string }>

export class WorkbenchProjectionStore {
	constructor(readonly database: PluginDatabaseHandle<typeof workbenchProjectionDatabase>) {}

	async replaceAll<T extends ProjectionItem>(resource: string, items: readonly T[]): Promise<void> {
		await this.database.transaction(async (tx) => {
			await tx.delete(workbenchProjections).where(eq(workbenchProjections.resource, resource))
			if (items.length === 0) return
			await tx.insert(workbenchProjections).values(
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

	async upsert<T extends ProjectionItem>(resource: string, item: T, position = 0): Promise<void> {
		await this.database.transaction((tx) =>
			tx
				.insert(workbenchProjections)
				.values({
					resource,
					id: item.id,
					payload: item,
					position,
					updatedAt: Date.now(),
				})
				.onConflictDoUpdate({
					target: [workbenchProjections.resource, workbenchProjections.id],
					set: { payload: item, position, updatedAt: Date.now() },
				}),
		)
	}

	async remove(resource: string, id: string): Promise<void> {
		await this.database.transaction((tx) =>
			tx
				.delete(workbenchProjections)
				.where(and(eq(workbenchProjections.resource, resource), eq(workbenchProjections.id, id))),
		)
	}
}

export async function readWorkbenchProjection<T extends ProjectionItem>(
	db: PluginDatabaseClient<typeof workbenchProjectionDatabase>,
	resource: string,
): Promise<T[]> {
	const rows = await db
		.select({ payload: workbenchProjections.payload })
		.from(workbenchProjections)
		.where(eq(workbenchProjections.resource, resource))
		.orderBy(asc(workbenchProjections.position), asc(workbenchProjections.id))
	return rows.map(({ payload }) => payload as T)
}

export function workbenchProjectionQuery<T extends ProjectionItem>(resource: string) {
	return (db: PluginDatabaseClient<typeof workbenchProjectionDatabase>) =>
		readWorkbenchProjection<T>(db, resource)
}
