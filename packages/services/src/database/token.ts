import { defineContextCapability } from '@pluxel/core/host'
import type { DatabaseService } from './service'
export type DatabaseApi = Pick<DatabaseService, 'use'>
export const Database = defineContextCapability<DatabaseApi>('services.database', {
	access: 'owner',
	property: 'database',
})
declare module '@pluxel/core' {
	interface ContextServices {
		readonly database: DatabaseApi
	}
}
