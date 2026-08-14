import './vault/VaultService'
import type { VaultAdminService } from './vault/VaultService'
import type { VaultServiceConfig, VaultStorageApi } from './vault/types'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			vault?: VaultServiceConfig
		}
		interface Services {
			vault: VaultStorageApi
		}
		interface RootServices {
			vaultAdmin: VaultAdminService
		}
	}
}

export type { VaultAdminService } from './vault/VaultService'
export type {
	VaultAdminApi,
	VaultAdminState,
	VaultBlobHandle,
	VaultBlobsHandle,
	VaultCollectionHandle,
	VaultDocsHandle,
	VaultKeyPair,
	VaultKvHandle,
	VaultKvTransaction,
	VaultNamespace,
	VaultNamespaceOptions,
	VaultNamespaceStats,
	VaultNamespaceTransaction,
	VaultServiceConfig,
} from './vault/types'
