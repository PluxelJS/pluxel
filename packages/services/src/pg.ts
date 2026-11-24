import type { DatabaseDefinition, PluginDatabaseHandle } from './database/definition'

export {
	defineDatabase,
	type DatabaseDefinition,
	type DatabaseEvolution,
	type DatabaseRequirement,
	type PluginDatabaseClient,
	type PluginDatabaseHandle,
	type PluginDatabaseTransaction,
} from './database/definition'

/** PostgreSQL access scoped to the calling Plugin and its migration history. */
export abstract class Pg {
	static readonly access = 'owner' as const

	/** Prepare this Plugin's database and reuse its handle for subsequent calls with the same definition. */
	abstract use<Definition extends DatabaseDefinition>(
		definition: Definition,
	): Promise<PluginDatabaseHandle<Definition>>
}
