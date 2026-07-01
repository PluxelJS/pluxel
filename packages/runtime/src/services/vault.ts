import './vault/VaultService'

export { bootstrapHostVault } from './security/bootstrap'
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
