import { installScopeService } from '@pluxel/core/host'
import { defineHostService, type HostService } from '@pluxel/host'
import { Pg } from '../pg'
import type { DatabaseDefinition } from './definition'
import type { DatabaseBackend, DatabaseService } from './service'

export function installPg(backend: DatabaseBackend): HostService {
	return defineHostService({
		name: 'Pg',
		provides: [
			installScopeService(Pg, {
				create: (owner) => {
					let service: Promise<DatabaseService> | undefined
					return Object.freeze({
						async use<Definition extends DatabaseDefinition>(definition: Definition) {
							service ??= import('./service').then(
								({ DatabaseService }) => new DatabaseService(owner, backend),
							)
							const pg = await service
							return pg.use(definition)
						},
					})
				},
			}),
		],
	})
}
