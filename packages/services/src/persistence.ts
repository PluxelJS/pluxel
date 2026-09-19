import { installRootCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { Persistence } from './persistence/token'
import { PersistenceService, type PersistenceServiceConfig } from './persistence/service'

export { Persistence } from './persistence/token'
export {
	type PersistenceService,
	PersistenceError,
	createMemoryPersistenceBackend,
	createNodePersistenceBackend,
	createReadonlyPersistenceBackend,
	createWorkspacePersistenceBackend,
	type PersistenceBackend,
	type PersistenceCapability,
	type PersistenceEntry,
	type PersistenceNamespace,
	type PersistenceRequirement,
	type PersistenceServiceConfig,
	type WorkspacePersistenceBackendFs,
	type WorkspacePersistenceBackendOptions,
	type MemoryPersistenceBackendOptions,
} from './persistence/service'

/** Select storage explicitly. This declaration creates no backend or filesystem resources. */
export function persistence(config: PersistenceServiceConfig) {
	const snapshot = typeof config === 'string' ? config : Object.freeze({ ...config })
	return defineHostService({
		name: 'Persistence',
		capabilities: [
			installRootCapability(Persistence, {
				property: 'persistence',
				create: () => new PersistenceService(snapshot),
			}),
		],
	})
}
