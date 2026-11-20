import type { DatabaseService } from './service'
export type DatabaseApi = Pick<DatabaseService, 'use'>
export abstract class Database {
	static readonly access = 'owner' as const
}
export interface Database extends DatabaseApi {}
