import { defineContextCapability, type ContextCapability } from '@pluxel/core/host'
import type { VaultAdminService } from './service'
import type { VaultStorageApi } from './types'

export const Vault: ContextCapability<VaultStorageApi> = defineContextCapability<VaultStorageApi>(
	'services.vault',
	{
		access: 'all',
		property: 'vault',
	},
)
export const VaultAdmin: ContextCapability<VaultAdminService, 'root'> =
	defineContextCapability<VaultAdminService>('services.vault-admin', {
		access: 'root',
		property: 'vaultAdmin',
	})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly vault: VaultStorageApi
	}
	interface RootContextServices {
		readonly vaultAdmin: VaultAdminService
	}
}
