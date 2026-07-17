import type { Context } from '@pluxel/runtime'
import type { PluginDatabaseHandle } from '@pluxel/runtime/database'
import { externalGatewayDatabase } from './schema.ts'

export type ExternalGatewayDbHandle = PluginDatabaseHandle<typeof externalGatewayDatabase>

export async function useExternalGatewayDB(ctx: Context): Promise<ExternalGatewayDbHandle> {
	return await ctx.database.use(externalGatewayDatabase)
}
