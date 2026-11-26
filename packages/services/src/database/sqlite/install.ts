import { defineHostService, installScopeService, type HostService } from '@pluxel/host/application'
import { Sqlite, type DatabaseDefinition, type PluginDatabaseHandle } from '../../sqlite'
import type { DatabaseArtifact } from '../artifact'
import { bindDatabaseOwner, runDatabaseOperation } from '../owner'
import type { DriverDatabase } from './handle'

export function installSqlite(
	open: <Schema extends Record<string, unknown>>(
		ownerId: string,
		definition: DatabaseDefinition<Schema>,
		artifact: DatabaseArtifact,
	) => Promise<{
		db: DriverDatabase<Schema>
		supportsInteractiveTransactions: boolean
		close?(): void | Promise<void>
	}>,
): HostService {
	const scope = installScopeService(Sqlite, {
		create(owner) {
			const acquire = bindDatabaseOwner(owner, 'sqlite')
			return Object.freeze({
				use<Definition extends DatabaseDefinition>(
					definition: Definition,
				): Promise<PluginDatabaseHandle<Definition>> {
					return acquire(definition, async (ownerId, artifact) => {
						const { db, close, supportsInteractiveTransactions } = await open<Definition['schema']>(
							ownerId,
							definition,
							artifact,
						)
						if (close) owner.effects.defer(close, { tag: 'Sqlite' })
						return Object.freeze({
							supportsInteractiveTransactions,
							run<Result>(callback: (client: typeof db) => Result | PromiseLike<Result>) {
								return runDatabaseOperation(owner, () => callback(db))
							},
						})
					})
				},
			})
		},
	})
	return defineHostService({ name: 'Sqlite', provides: [scope] })
}
