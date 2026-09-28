import { defineContextCapability, type ContextCapability } from '@pluxel/core/host'
import type { PersistenceService } from './service'

export const Persistence: ContextCapability<PersistenceService, 'root'> =
	defineContextCapability<PersistenceService>('services.persistence', {
		access: 'root',
		property: 'persistence',
	})

declare module '@pluxel/core' {
	interface RootContextServices {
		readonly persistence: PersistenceService
	}
}
