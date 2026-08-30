import { randomBytes } from 'node:crypto'
import type { AuthMode } from './config.ts'
import type { LocalAccountRecord } from './credentials.ts'
import {
	hashPassword,
	normalizeUsername,
	PasswordHashBusyError,
	type PasswordRecord,
} from './password.ts'
import { createTotpSecret, totpProvisioningUri, verifyTotp, type TotpRecord } from './totp.ts'
import type {
	AuthOidcSecretSetupInput,
	AuthPasswordSetupInput,
	AuthSetupFailure,
	AuthTotpConfirmationInput,
	AuthTotpEnrollmentResult,
} from './workbench.ts'

const MAX_ENROLLMENTS = 16
const ENROLLMENT_TTL_MS = 10 * 60_000
const MAX_ENROLLMENT_ATTEMPTS = 5

type Enrollment = {
	readonly username: string
	readonly normalizedUsername: string
	readonly password: PasswordRecord
	readonly secret: string
	readonly expiresAt: number
	attempts: number
}

export type CredentialSetupResult = Readonly<{ ok: true }> | AuthSetupFailure

type PreparedAccount = Readonly<{
	username: string
	normalizedUsername: string
	password: PasswordRecord
}>

export type CredentialProvisioningStore = Readonly<{
	available: boolean
	saveAccount(account: LocalAccountRecord): Promise<void>
	saveOidcSecret(secret: string): Promise<void>
}>

function failure(code: AuthSetupFailure['code'], message: string): AuthSetupFailure {
	return Object.freeze({ ok: false, code, message })
}

/** Owns one setup View's bounded credential enrollment state. */
export class CredentialProvisioning {
	private readonly enrollments = new Map<string, Enrollment>()
	private disposed = false

	constructor(
		private readonly mode: AuthMode,
		private readonly store: CredentialProvisioningStore,
		private readonly applyAccount: (account: LocalAccountRecord) => void,
		private readonly applyOidcSecret: (secret: string) => void,
	) {}

	async setupPassword(input: AuthPasswordSetupInput): Promise<CredentialSetupResult> {
		if (this.disposed || this.mode.type !== 'password') {
			return failure('not_required', 'Password setup is not available.')
		}
		const base = await this.prepareAccount(input)
		if ('ok' in base) return base
		return await this.saveAccount({ version: 1, type: 'local-account', ...base })
	}

	async beginTotp(input: AuthPasswordSetupInput): Promise<AuthTotpEnrollmentResult> {
		if (this.disposed || this.mode.type !== 'password-totp') {
			return failure('not_required', 'Password and TOTP setup is not available.')
		}
		const base = await this.prepareAccount(input)
		if ('ok' in base) return base
		if (this.disposed) return failure('unavailable', 'Credential setup is closed.')
		this.pruneEnrollments()
		while (this.enrollments.size >= MAX_ENROLLMENTS) {
			const oldest = this.enrollments.keys().next().value as string | undefined
			if (!oldest) break
			this.enrollments.delete(oldest)
		}
		const id = randomBytes(24).toString('base64url')
		const secret = createTotpSecret()
		const expiresAt = Date.now() + ENROLLMENT_TTL_MS
		this.enrollments.set(id, {
			...base,
			secret,
			expiresAt,
			attempts: 0,
		})
		return Object.freeze({
			ok: true,
			enrollment: Object.freeze({
				id,
				secret,
				provisioningUri: totpProvisioningUri({ secret, username: base.username }),
				expiresAt,
			}),
		})
	}

	async confirmTotp(input: AuthTotpConfirmationInput): Promise<CredentialSetupResult> {
		if (this.disposed) return failure('unavailable', 'Credential setup is closed.')
		if (this.mode.type !== 'password-totp') {
			return failure('not_required', 'Password and TOTP setup is not available.')
		}
		const confirmation = parseTotpConfirmation(input)
		if (!confirmation) {
			return failure('invalid_input', 'The TOTP confirmation input is invalid.')
		}
		const enrollment = this.enrollments.get(confirmation.enrollmentId)
		if (!enrollment || enrollment.expiresAt <= Date.now()) {
			this.enrollments.delete(confirmation.enrollmentId)
			return failure('enrollment_expired', 'The TOTP enrollment is invalid or expired.')
		}
		enrollment.attempts += 1
		if (enrollment.attempts > MAX_ENROLLMENT_ATTEMPTS) {
			this.enrollments.delete(confirmation.enrollmentId)
			return failure('enrollment_expired', 'The TOTP enrollment is invalid or expired.')
		}
		const counter = verifyTotp(confirmation.code, {
			secret: enrollment.secret,
			lastAcceptedCounter: -1,
		})
		if (counter === undefined) {
			return failure('verification_failed', 'The one-time code was not accepted.')
		}
		const totp: TotpRecord = {
			algorithm: 'sha1',
			digits: 6,
			period: 30,
			secret: enrollment.secret,
			lastAcceptedCounter: counter,
		}
		const saved = await this.saveAccount({
			version: 1,
			type: 'local-account',
			username: enrollment.username,
			normalizedUsername: enrollment.normalizedUsername,
			password: enrollment.password,
			totp,
		})
		if (saved.ok) this.enrollments.delete(confirmation.enrollmentId)
		return saved
	}

	async setupOidcSecret(input: AuthOidcSecretSetupInput): Promise<CredentialSetupResult> {
		if (this.disposed || this.mode.type !== 'oidc' || this.mode.clientKind !== 'confidential') {
			return failure('not_required', 'The configured OIDC client does not require a secret.')
		}
		const secret = parseOidcSecret(input)
		if (secret === undefined) return failure('invalid_input', 'The client secret is invalid.')
		if (secret.length === 0 || secret.length > 4_096) {
			return failure('invalid_input', 'The client secret is invalid.')
		}
		if (!this.store.available) return failure('unavailable', 'Vault is unavailable.')
		try {
			await this.store.saveOidcSecret(secret)
		} catch {
			return failure('storage_failed', 'The client secret could not be persisted.')
		}
		this.applyOidcSecret(secret)
		return Object.freeze({ ok: true })
	}

	[Symbol.dispose](): void {
		if (this.disposed) return
		this.disposed = true
		this.enrollments.clear()
	}

	private async prepareAccount(
		input: AuthPasswordSetupInput,
	): Promise<PreparedAccount | AuthSetupFailure> {
		if (!this.store.available) return failure('unavailable', 'Vault is unavailable.')
		const parsed = parsePasswordSetup(input)
		if (!parsed) return failure('invalid_input', 'The account input is invalid.')
		const username = parsed.username.trim()
		const normalizedUsername = normalizeUsername(username)
		if (!normalizedUsername) {
			return failure(
				'invalid_input',
				'Account names may use letters, numbers, dot, underscore, @, and hyphen.',
			)
		}
		if (parsed.password !== parsed.passwordConfirmation) {
			return failure('invalid_input', 'Passwords do not match.')
		}
		try {
			return Object.freeze({
				username,
				normalizedUsername,
				password: await hashPassword(parsed.password),
			})
		} catch (error) {
			return failure(
				error instanceof PasswordHashBusyError ? 'busy' : 'invalid_input',
				error instanceof PasswordHashBusyError
					? 'Password hashing is temporarily busy.'
					: 'Use a password of at least 12 characters.',
			)
		}
	}

	private async saveAccount(account: LocalAccountRecord): Promise<CredentialSetupResult> {
		if (this.disposed) return failure('unavailable', 'Credential setup is closed.')
		try {
			await this.store.saveAccount(account)
		} catch {
			return failure('storage_failed', 'The account could not be persisted.')
		}
		this.applyAccount(Object.freeze(account))
		return Object.freeze({ ok: true })
	}

	private pruneEnrollments(): void {
		const now = Date.now()
		for (const [id, enrollment] of this.enrollments) {
			if (enrollment.expiresAt <= now) this.enrollments.delete(id)
		}
	}
}

function parsePasswordSetup(input: unknown): AuthPasswordSetupInput | undefined {
	const record = exactRecord(input, ['username', 'password', 'passwordConfirmation'])
	if (
		!record ||
		typeof record.username !== 'string' ||
		record.username.length > 128 ||
		typeof record.password !== 'string' ||
		record.password.length > 1_024 ||
		typeof record.passwordConfirmation !== 'string' ||
		record.passwordConfirmation.length > 1_024
	) {
		return undefined
	}
	return Object.freeze({
		username: record.username,
		password: record.password,
		passwordConfirmation: record.passwordConfirmation,
	})
}

function parseTotpConfirmation(input: unknown): AuthTotpConfirmationInput | undefined {
	const record = exactRecord(input, ['enrollmentId', 'code'])
	if (
		!record ||
		typeof record.enrollmentId !== 'string' ||
		!/^[A-Za-z0-9_-]{32}$/.test(record.enrollmentId) ||
		typeof record.code !== 'string' ||
		!/^[0-9]{6}$/.test(record.code)
	) {
		return undefined
	}
	return Object.freeze({ enrollmentId: record.enrollmentId, code: record.code })
}

function parseOidcSecret(input: unknown): string | undefined {
	const record = exactRecord(input, ['secret'])
	return record && typeof record.secret === 'string' ? record.secret : undefined
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
	const record = input as Record<string, unknown>
	const actual = Object.keys(record).sort()
	const expected = [...keys].sort()
	return actual.length === expected.length && actual.every((key, index) => key === expected[index])
		? record
		: undefined
}
