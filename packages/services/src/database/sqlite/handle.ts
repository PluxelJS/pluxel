import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { DatabaseDefinition } from '../../sqlite'

export interface DriverDatabase<Schema extends Record<string, unknown>> extends BaseSQLiteDatabase<
	'async',
	unknown,
	Schema
> {
	batch<Item extends BatchItem<'sqlite'>, Items extends readonly [Item, ...Item[]]>(
		items: Items,
	): Promise<BatchResponse<Items>>
}

interface BorrowedDatabase<Client, InteractiveTransactions extends boolean> {
	readonly supportsInteractiveTransactions: InteractiveTransactions
	run<Result>(callback: (db: Client) => Result | PromiseLike<Result>): Promise<Result>
}

/** Both drivers support atomic batches. Narrow the handle for an interactive transaction. */
export type PluginDatabaseHandle<Definition extends DatabaseDefinition = DatabaseDefinition> =
	| BorrowedDatabase<Omit<DriverDatabase<Definition['schema']>, 'transaction'>, false>
	| BorrowedDatabase<DriverDatabase<Definition['schema']>, true>
