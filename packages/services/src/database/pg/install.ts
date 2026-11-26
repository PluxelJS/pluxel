import { defineHostService, installScopeService, type HostService } from '@pluxel/host/application'
import { Pg, type DatabaseDefinition } from '../../pg'
import { bindDatabaseOwner } from '../owner'
import type { DatabaseBackend } from './coordinator'

export function installPg(backend: DatabaseBackend): HostService {
	const scope = installScopeService(Pg, {
		create(owner) {
			const acquire = bindDatabaseOwner(owner, 'postgresql')
			return Object.freeze({
				use<Definition extends DatabaseDefinition>(definition: Definition) {
					return acquire(definition, async (ownerId, artifact) => {
						const { acquirePgDatabase } = await import('./coordinator')
						return acquirePgDatabase(owner, ownerId, definition, artifact, backend)
					})
				},
			})
		},
	})
	return defineHostService({ name: 'Pg', provides: [scope] })
}
