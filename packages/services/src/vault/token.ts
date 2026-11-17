import type { VaultAdminApi, VaultStorageApi } from './types'
export abstract class Vault {}
export interface Vault extends VaultStorageApi {}
export abstract class VaultAdmin {
	static readonly access = 'root' as const
}
export interface VaultAdmin extends VaultAdminApi {}
