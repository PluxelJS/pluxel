import { and, asc, eq } from 'drizzle-orm'
import type { Context } from '@pluxel/runtime'
import type { PluginDatabaseClient } from '@pluxel/runtime/database'
import { workbench } from '@pluxel/runtime/workbench'
import { useExternalGatewayDB, type ExternalGatewayDbHandle } from './db/use-db.ts'
import { externalGatewayDatabase, workbenchProjections } from './db/schema.ts'

type ProjectionItem = Readonly<{ id: string }>

export class WorkbenchProjectionStore {
	constructor(readonly database: ExternalGatewayDbHandle) {}

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
				.values({ resource, id: item.id, payload: item, position, updatedAt: Date.now() })
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
	db: PluginDatabaseClient<typeof externalGatewayDatabase>,
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
	return (db: PluginDatabaseClient<typeof externalGatewayDatabase>) =>
		readWorkbenchProjection<T>(db, resource)
}

type ProjectionSource<T extends ProjectionItem> = Readonly<{
	snapshot(): T[]
	subscribe(listener: () => void): () => void
}>

export async function createWorkbenchProjection<
	Sources extends Readonly<Record<string, ProjectionSource<any>>>,
>(ctx: Context, sources: Sources) {
	if (!ctx.workbench.enabled) return undefined
	const database = await useExternalGatewayDB(ctx)
	const store = new WorkbenchProjectionStore(database)
	await Promise.all(
		Object.entries(sources).map(([resource, source]) =>
			store.replaceAll(resource, source.snapshot()),
		),
	)
	for (const [resource, source] of Object.entries(sources)) {
		ctx.effects.defer(
			source.subscribe(() => {
				void store.replaceAll(resource, source.snapshot()).catch((error) => {
					ctx.logger.warn('Failed to update Workbench database projection', { resource, error })
				})
			}),
		)
	}
	return Object.freeze({
		binding<Key extends keyof Sources & string>(resource: Key) {
			type Item = ReturnType<Sources[Key]['snapshot']>[number]
			return workbench.bind.liveQuery({
				database,
				dependsOn: [workbenchProjections],
				query: workbenchProjectionQuery<Item>(resource),
			})
		},
	})
}
