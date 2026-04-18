import type {
	VerificationOtpProvisionResult,
	VerificationOtpUserProvisionInput,
	VerificationPasskeyRegistrationFinishInput,
	VerificationPasskeyRegistrationOptions,
	VerificationPasskeyRegistrationStartInput,
	VerificationPasswordUserUpsertInput,
	VerificationUserDeleteInput,
	VaultKeyPair,
} from './protocol'
import type { SecurityEvent } from '../services/security/audit'
import type {
	VerificationAdminState,
	VerificationMethod,
	VerificationMode,
} from '../services/verification/types'
import type { VaultAdminState } from '../services/vault/types'
export type { VerificationAdminState } from '../services/verification/types'
export type { VaultAdminState } from '../services/vault/types'
import {
	HMR_SECURITY_EVENTS_PATH,
	HMR_SECURITY_BASE,
	HMR_SECURITY_VERIFICATION_METHOD_PATH,
	HMR_SECURITY_VERIFICATION_MODE_PATH,
	HMR_SECURITY_VERIFICATION_OTP_USERS_PATH,
	HMR_SECURITY_VERIFICATION_PASSKEY_REGISTER_OPTIONS_PATH,
	HMR_SECURITY_VERIFICATION_PASSKEY_REGISTER_PATH,
	HMR_SECURITY_VERIFICATION_PASSWORD_USERS_PATH,
	HMR_SECURITY_VERIFICATION_USERS_DELETE_PATH,
	HMR_SECURITY_VAULT_DEPLOY_GENERATE_PATH,
	HMR_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH,
	HMR_SECURITY_VAULT_HOST_KEY_PATH,
	HMR_SECURITY_VAULT_UNLOCK_PATH,
	joinPath,
} from './paths'
import { requestJson, resolveClientUrl, withJsonBody, withMethod } from './http-utils'
import type { RuntimeFetch } from './verification'

export type SecurityAuditEvent = SecurityEvent
export type SecurityOverview = {
	verification: VerificationAdminState
	vault: VaultAdminState
}

export interface RuntimeSecurityClient {
	readOverview(init?: RequestInit): Promise<SecurityOverview>
	listEvents(init?: RequestInit): Promise<SecurityAuditEvent[]>
	verification: {
		setMode(mode: VerificationMode, init?: RequestInit): Promise<VerificationAdminState>
		setMethod(method: VerificationMethod, init?: RequestInit): Promise<VerificationAdminState>
		upsertPasswordUser(
			input: VerificationPasswordUserUpsertInput,
			init?: RequestInit,
		): Promise<VerificationAdminState>
		provisionOtpUser(
			input: VerificationOtpUserProvisionInput,
			init?: RequestInit,
		): Promise<VerificationOtpProvisionResult>
		deleteUser(input: VerificationUserDeleteInput, init?: RequestInit): Promise<VerificationAdminState>
		beginPasskeyRegistration(
			input: VerificationPasskeyRegistrationStartInput,
			init?: RequestInit,
		): Promise<VerificationPasskeyRegistrationOptions>
		finishPasskeyRegistration(
			input: VerificationPasskeyRegistrationFinishInput,
			init?: RequestInit,
		): Promise<VerificationAdminState>
	}
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
	const baseUrl = resolveClientUrl(joinPath(apiBase, HMR_SECURITY_BASE))

	return {
		readOverview: (init) => requestJson<SecurityOverview>(fetch, baseUrl, init),
		listEvents: (init) =>
			requestJson<SecurityAuditEvent[]>(
				fetch,
				resolveClientUrl(joinPath(apiBase, HMR_SECURITY_EVENTS_PATH)),
				init,
			),
		verification: {
			setMode: (mode, init) =>
				requestJson<VerificationAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_MODE_PATH)),
					withJsonBody(init, { mode }, 'POST'),
				),
			setMethod: (method, init) =>
				requestJson<VerificationAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_METHOD_PATH)),
					withJsonBody(init, { method }, 'POST'),
				),
			upsertPasswordUser: (input, init) =>
				requestJson<VerificationAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_PASSWORD_USERS_PATH)),
					withJsonBody(init, input, 'POST'),
				),
			provisionOtpUser: (input, init) =>
				requestJson<VerificationOtpProvisionResult>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_OTP_USERS_PATH)),
					withJsonBody(init, input, 'POST'),
				),
			deleteUser: (input, init) =>
				requestJson<VerificationAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_USERS_DELETE_PATH)),
					withJsonBody(init, input, 'POST'),
				),
			beginPasskeyRegistration: (input, init) =>
				requestJson<VerificationPasskeyRegistrationOptions>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_PASSKEY_REGISTER_OPTIONS_PATH)),
					withJsonBody(init, input, 'POST'),
				),
			finishPasskeyRegistration: (input, init) =>
				requestJson<VerificationAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VERIFICATION_PASSKEY_REGISTER_PATH)),
					withJsonBody(init, input, 'POST'),
				),
		},
		vault: {
			unlock: (init) =>
				requestJson<VaultAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VAULT_UNLOCK_PATH)),
					withMethod(init, 'POST'),
				),
			ensureHostKey: (init) =>
				requestJson<{ publicKey: string }>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VAULT_HOST_KEY_PATH)),
					withMethod(init, 'POST'),
				),
			generateDeployKey: (init) =>
				requestJson<VaultKeyPair>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VAULT_DEPLOY_GENERATE_PATH)),
					withMethod(init, 'POST'),
				),
			setDeployRecipients: (publicKeys, init) =>
				requestJson<VaultAdminState>(
					fetch,
					resolveClientUrl(joinPath(apiBase, HMR_SECURITY_VAULT_DEPLOY_RECIPIENTS_PATH)),
					withJsonBody(init, { publicKeys }, 'POST'),
				),
		},
	}
}
