import type { VaultKeyPair } from './protocol'
import type { SecurityEvent } from '../services/security/audit'
import type { VerificationOverview } from '../services/verification/types'
import type { VaultAdminState } from '../services/vault/types'
export type { VerificationOverview } from '../services/verification/types'
export type { VaultAdminState } from '../services/vault/types'
import {
	RUNTIME_SECURITY_EVENTS_PATH,
	RUNTIME_SECURITY_BASE,
	RUNTIME_SECURITY_VAULT_DEPLOY_GENERATE_PATH,
	RUNTIME_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH,
	RUNTIME_SECURITY_VAULT_HOST_KEY_PATH,
	RUNTIME_SECURITY_VAULT_UNLOCK_PATH,
	joinPath,
} from './paths'
import { requestJson, resolveClientUrl, withJsonBody, withMethod } from './http-utils'
import type { RuntimeFetch } from './verification'

export type SecurityAuditEvent = SecurityEvent
export type SecurityOverview = {
	verification: VerificationOverview
	vault: VaultAdminState
}

export interface RuntimeSecurityClient {
	readOverview(init?: RequestInit): Promise<SecurityOverview>
	listEvents(init?: RequestInit): Promise<SecurityAuditEvent[]>
	vault: {
		unlock(init?: RequestInit): Promise<VaultAdminState>
		ensureHostKey(init?: RequestInit): Promise<{ publicKey: string }>
		generateDeployKey(init?: RequestInit): Promise<VaultKeyPair>
		setDeployRecipients(publicKeys: string[], init?: RequestInit): Promise<VaultAdminState>
	}
}

export type RuntimeSecurityClientOptions = {
	apiBase: string
	fetch: RuntimeFetch
}

export function createRuntimeSecurityClient(
	options: RuntimeSecurityClientOptions,
): RuntimeSecurityClient {
	const { fetch, apiBase } = options
	const baseUrl = resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_BASE))

	return {
		readOverview: (init) => requestJson<SecurityOverview>(fetch, baseUrl, init),
		listEvents: (init) =>
			requestJson<SecurityAuditEvent[]>(
				fetch,
				resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_EVENTS_PATH)),
				init,
			),
		vault: {
			unlock: (init) =>
				requestJson<VaultAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_UNLOCK_PATH)),
					withMethod(init, 'POST'),
				),
			ensureHostKey: (init) =>
				requestJson<{ publicKey: string }>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_HOST_KEY_PATH)),
					withMethod(init, 'POST'),
				),
			generateDeployKey: (init) =>
				requestJson<VaultKeyPair>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_DEPLOY_GENERATE_PATH)),
					withMethod(init, 'POST'),
				),
			setDeployRecipients: (publicKeys, init) =>
				requestJson<VaultAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH)),
					withJsonBody(init, { publicKeys }, 'POST'),
				),
		},
	}
}
