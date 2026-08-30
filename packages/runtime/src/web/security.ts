import type { SecurityEvent } from '../services/security/audit'
import type { AdminAccessOverview } from '../services/admin-access/types'
import type { VaultAdminState, VaultKeyPair } from '../services/vault/types'

export type { AdminAccessOverview } from '../services/admin-access/types'
export type { VaultAdminState, VaultKeyPair } from '../services/vault/types'

export type SecurityAuditEvent = SecurityEvent

export type SecurityOverview = Readonly<{
	adminAccess: AdminAccessOverview
	vault: Readonly<{ enabled: false }> | Readonly<{ enabled: true; state: VaultAdminState }>
}>

export type RuntimeSecurityClient = Readonly<{
	readOverview(): Promise<SecurityOverview>
	listEvents(limit?: number): Promise<readonly SecurityAuditEvent[]>
	vault: Readonly<{
		unlock(): Promise<VaultAdminState>
		ensureHostKey(): Promise<Readonly<{ publicKey: string }>>
		generateDeployKey(): Promise<VaultKeyPair>
		setDeployRecipients(publicKeys: readonly string[]): Promise<VaultAdminState>
	}>
}>
