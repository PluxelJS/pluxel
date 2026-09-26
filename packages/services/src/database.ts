import { installScopeCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { Database } from './database/token'
import type { DatabaseService, DatabaseBackend } from './database/service'
export { Database, type DatabaseApi } from './database/token'
export * from './database/definition'
export type { DatabaseBackend, DatabaseAdapter } from './database/service'

/** Explicit driver selection; backend loading remains lazy until a Plugin first uses it. */
export function database(options: { readonly backend: DatabaseBackend }) {
	if (!options || typeof options.backend !== 'function')
		throw new TypeError('[pluxel/database] provide a database backend factory')
	const backend = options.backend
	return defineHostService({
		name: 'Database',
		capabilities: [
			installScopeCapability(Database, {
				property: 'database',
				create: (owner) => {
					let service: Promise<DatabaseService> | undefined
					return Object.freeze({
						async use<Definition extends import('./database/definition').DatabaseDefinition>(
							definition: Definition,
						) {
							service ??= import('./database/service').then(
								({ DatabaseService }) => new DatabaseService(owner, { backend }),
							)
							const api = await service
							return api.use(definition)
						},
					})
				},
			}),
		],
	})
}
