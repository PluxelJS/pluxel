import type { VaultKvHandle } from '@pluxel/runtime/services/vault'
import { normalizeUsername, parsePasswordRecord, type PasswordRecord } from './password.ts'
import { parseTotpRecord, type TotpRecord } from './totp.ts'

const ACCOUNT_KEY = 'management-account-v1'
const OIDC_SECRET_KEY = 'oidc-client-secret-v1'

export type LocalAccountRecord = Readonly<{
	version: 1
	type: 'local-account'
	username: string
	normalizedUsername: string
	password: PasswordRecord
	totp?: TotpRecord
}>

type OidcSecretRecord = Readonly<{
	version: 1
	type: 'oidc-client-secret'
	secret: string
}>

function parseAccount(value: unknown): LocalAccountRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	const password = parsePasswordRecord(record.password)
	const totp = record.totp === undefined ? undefined : parseTotpRecord(record.totp)
	if (
		record.version !== 1 ||
		record.type !== 'local-account' ||
		typeof record.username !== 'string' ||
		record.username.length === 0 ||
		record.username.length > 64 ||
		typeof record.normalizedUsername !== 'string' ||
		record.normalizedUsername.length === 0 ||
		record.normalizedUsername.length > 64 ||
		normalizeUsername(record.username) !== record.normalizedUsername ||
		!password ||
		(record.totp !== undefined && !totp)
	) {
		return undefined
	}
	return Object.freeze({
		version: 1,
		type: 'local-account',
		username: record.username,
		normalizedUsername: record.normalizedUsername,
		password,
		...(totp ? { totp } : {}),
	})
}

function parseOidcSecret(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Partial<OidcSecretRecord>
	return record.version === 1 &&
		record.type === 'oidc-client-secret' &&
		typeof record.secret === 'string' &&
		record.secret.length > 0 &&
		record.secret.length <= 4_096
		? record.secret
		: undefined
}

export class CredentialStore {
	private readonly kv?: VaultKvHandle

	constructor(
		private readonly vault?: Readonly<{
			kv(): VaultKvHandle
			flush(): Promise<void>
		}>,
	) {
		this.kv = vault?.kv()
	}

	get available(): boolean {
		return this.kv !== undefined
	}

	async loadAccount(): Promise<{ account?: LocalAccountRecord; invalid: boolean }> {
		const value = await this.kv?.get(ACCOUNT_KEY)
		if (value === undefined) return { invalid: false }
		const account = parseAccount(value)
		return account ? { account, invalid: false } : { invalid: true }
	}

	async saveAccount(account: LocalAccountRecord): Promise<void> {
		if (!this.kv || !this.vault) throw new Error('Vault is unavailable')
		await this.kv.set(ACCOUNT_KEY, account)
		await this.vault.flush()
	}

	async loadOidcSecret(): Promise<{ secret?: string; invalid: boolean }> {
		const value = await this.kv?.get(OIDC_SECRET_KEY)
		if (value === undefined) return { invalid: false }
		const secret = parseOidcSecret(value)
		return secret ? { secret, invalid: false } : { invalid: true }
	}

	async saveOidcSecret(secret: string): Promise<void> {
		if (!this.kv || !this.vault) throw new Error('Vault is unavailable')
		if (secret.length === 0 || secret.length > 4_096) throw new TypeError('Invalid OIDC secret')
		await this.kv.set(OIDC_SECRET_KEY, {
			version: 1,
			type: 'oidc-client-secret',
			secret,
		} satisfies OidcSecretRecord)
		await this.vault.flush()
	}
}
