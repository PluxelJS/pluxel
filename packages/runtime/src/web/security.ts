import type { VaultKeyPair } from './protocol'
import type { SecurityEvent } from '../services/security/audit'
import type { AdminAccessOverview } from '../services/admin-access/types'
import type { VaultAdminState } from '../services/vault/types'
export type { AdminAccessOverview } from '../services/admin-access/types'
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
import type { RuntimeFetch } from './admin-access'
import {
	parseSecurityAuditEvents,
	parseSecurityOverview,
	parseVaultAdminState,
	parseVaultKeyPair,
	parseVaultPublicKeyResult,
} from './management-validation'

export type SecurityAuditEvent = SecurityEvent
export type SecurityOverview = {
	adminAccess: AdminAccessOverview
	vault: Readonly<{ enabled: false }> | Readonly<{ enabled: true; state: VaultAdminState }>
}

export type RuntimeSecurityClient = Readonly<{
	readOverview(init?: RequestInit): Promise<SecurityOverview>
	listEvents(init?: RequestInit): Promise<readonly SecurityAuditEvent[]>
	vault: Readonly<{
		unlock(init?: RequestInit): Promise<VaultAdminState>
		ensureHostKey(init?: RequestInit): Promise<{ publicKey: string }>
		generateDeployKey(init?: RequestInit): Promise<VaultKeyPair>
		setDeployRecipients(publicKeys: readonly string[], init?: RequestInit): Promise<VaultAdminState>
	}>
}>

export type RuntimeSecurityClientOptions = Readonly<{
	apiBase: string
	fetch: RuntimeFetch
}>

export function createRuntimeSecurityClient(
	options: RuntimeSecurityClientOptions,
): RuntimeSecurityClient {
	const { fetch, apiBase } = options
	const baseUrl = resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_BASE))
	const vault = Object.freeze({
		unlock: async (init?: RequestInit) =>
			parseVaultAdminState(
				await requestJson<unknown>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_UNLOCK_PATH)),
					withMethod(init, 'POST'),
				),
			),
		ensureHostKey: async (init?: RequestInit) =>
			parseVaultPublicKeyResult(
				await requestJson<unknown>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_HOST_KEY_PATH)),
					withMethod(init, 'POST'),
				),
			),
		generateDeployKey: async (init?: RequestInit) =>
			parseVaultKeyPair(
				await requestJson<unknown>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_DEPLOY_GENERATE_PATH)),
					withMethod(init, 'POST'),
				),
			),
		setDeployRecipients: async (publicKeys: readonly string[], init?: RequestInit) =>
			parseVaultAdminState(
				await requestJson<unknown>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH)),
					withJsonBody(init, { publicKeys: [...publicKeys] }, 'POST'),
				),
			),
	})

	return Object.freeze({
		readOverview: async (init?: RequestInit) =>
			parseSecurityOverview(await requestJson<unknown>(fetch, baseUrl, init)),
		listEvents: async (init?: RequestInit) =>
			parseSecurityAuditEvents(
				await requestJson<unknown>(
					fetch,
					resolveClientUrl(joinPath(apiBase, RUNTIME_SECURITY_EVENTS_PATH)),
					init,
				),
			),
		vault,
	})
}
