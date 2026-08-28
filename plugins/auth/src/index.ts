import { randomBytes } from 'node:crypto'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { AuthConfig, type AuthPluginConfig } from './config.ts'
import type {
	AuthDecision,
	AuthPrincipal,
	AuthProviderStatus,
	AuthRequestContext,
	ManagementAuthProvider,
} from './contracts.ts'
import { CredentialStore, type LocalAccountRecord } from './credentials.ts'
import {
	AuthHttpController,
	type AuthHttpActions,
	type SetupResult,
	type SetupSnapshot,
	type TotpEnrollmentView,
} from './http.ts'
import { LoginFailureLimiter } from './login-failures.ts'
import { OidcClient, readBearer } from './oidc.ts'
import {
	hashPassword,
	normalizeUsername,
	PasswordHashBusyError,
	type PasswordRecord,
	usernameMatches,
	verifyPassword,
} from './password.ts'
import { clearSessionCookie, SessionStore } from './sessions.ts'
import { createTotpSecret, totpProvisioningUri, verifyTotp, type TotpRecord } from './totp.ts'

export { AuthConfig } from './config.ts'
export type { AuthPluginConfig, AuthMode, OidcAuthMode } from './config.ts'
export type {
	AuthDecision,
	AuthMethod,
	AuthPrincipal,
	AuthProviderStatus,
	AuthRequestContext,
} from './contracts.ts'

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

function failure(message: string): SetupResult {
	return { ok: false, message }
}

@Plugin({ displayName: 'Authentication' })
export class AuthPlugin extends BasePlugin {
	private readonly config: AuthPluginConfig = this.configs.use(AuthConfig)
	private readonly sessions = new SessionStore()
	private readonly enrollments = new Map<string, Enrollment>()
	private readonly loginFailures = new LoginFailureLimiter()
	private active = false
	private store?: CredentialStore
	private account?: LocalAccountRecord
	private oidcSecret?: string
	private accountInvalid = false
	private oidcSecretInvalid = false
	private oidc?: OidcClient
	private http?: AuthHttpController
	private totpMutation: Promise<void> = Promise.resolve()

	private readonly provider: ManagementAuthProvider = Object.freeze({
		status: (): AuthProviderStatus => this.status(),
		authorize: (request: Request, context: AuthRequestContext): Promise<AuthDecision> =>
			this.authenticateRequest(request, context),
		handle: (request: Request, context: AuthRequestContext): Promise<Response | undefined> =>
			this.requireHttp().handle(request, context),
	})

	protected override async init(): Promise<void> {
		const store = new CredentialStore(this.ctx.vault)
		this.store = store
		const mode = this.config.mode
		const [accountState, oidcState] = await Promise.all([
			mode.type === 'oidc'
				? Promise.resolve({ account: undefined, invalid: false } as const)
				: store.loadAccount(),
			mode.type === 'oidc' && mode.clientKind === 'confidential'
				? store.loadOidcSecret()
				: Promise.resolve({ secret: undefined, invalid: false } as const),
		])
		this.account = accountState.account
		this.oidcSecret = oidcState.secret
		this.accountInvalid = accountState.invalid
		this.oidcSecretInvalid = oidcState.invalid
		if (this.config.mode.type === 'oidc') {
			this.oidc = new OidcClient(this.config.mode, () => this.oidcSecret)
		}

		this.http = new AuthHttpController(this.httpActions())
		this.active = true
		this.ctx.effects.defer(
			() => {
				this.active = false
				this.sessions.clear()
				this.enrollments.clear()
				this.loginFailures.clear()
				this.oidc?.clear()
				this.http = undefined
				this.store = undefined
				this.account = undefined
				this.oidcSecret = undefined
			},
			{ tag: 'auth-generation', phase: 'shutdown' },
		)
		this.ctx.managementAccess?.provide(this.provider)
	}

	/** Authenticate the same session or OIDC bearer accepted by the management provider. */
	async authenticate(request: Request): Promise<AuthDecision> {
		const url = new URL(request.url)
		return this.authenticateRequest(
			request,
			Object.freeze({
				local: false,
				secure: url.protocol === 'https:',
			}),
		)
	}

	private async authenticateRequest(
		request: Request,
		context: AuthRequestContext,
	): Promise<AuthDecision> {
		if (!this.active || !this.ready()) return { allow: false, reason: 'unavailable' }
		if (!context.secure && !context.local) {
			return { allow: false, reason: 'secure_transport_required' }
		}
		const method = this.config.mode.type
		const session = this.sessions.read(request, method, context.local)
		if (session) return { allow: true, principal: session }
		if (method === 'oidc') {
			const token = readBearer(request)
			if (token) return await this.oidc!.authorizeBearer(token, request.signal)
		}
		return { allow: false, reason: 'unauthenticated' }
	}

	status(): AuthProviderStatus {
		return Object.freeze({
			id: '@pluxel/auth',
			label: 'Pluxel Authentication',
			method: this.config.mode.type,
			ready: this.ready(),
		})
	}

	private ready(): boolean {
		if (!this.active) return false
		const mode = this.config.mode
		if (mode.type === 'oidc') {
			return mode.clientKind === 'public' || (!this.oidcSecretInvalid && Boolean(this.oidcSecret))
		}
		if (this.accountInvalid) return false
		if (!this.account) return false
		return mode.type === 'password' || Boolean(this.account.totp)
	}

	private setupSnapshot(): SetupSnapshot {
		const mode = this.config.mode
		return Object.freeze({
			method: mode.type,
			ready: this.ready(),
			vaultAvailable: this.store?.available === true,
			credentialsInvalid:
				mode.type === 'oidc'
					? mode.clientKind === 'confidential' && this.oidcSecretInvalid
					: this.accountInvalid,
			...(this.account ? { accountName: this.account.username } : {}),
			...(mode.type === 'oidc'
				? {
						clientSecretRequired: mode.clientKind === 'confidential',
						clientSecretConfigured: Boolean(this.oidcSecret),
					}
				: {}),
		})
	}

	private httpActions(): AuthHttpActions {
		return Object.freeze({
			snapshot: () => this.setupSnapshot(),
			authorize: (request, context) => this.authenticateRequest(request, context),
			login: (input) => this.login(input),
			setupPassword: (input) => this.setupPassword(input),
			beginTotp: (input) => this.beginTotp(input),
			confirmTotp: (input) => this.confirmTotp(input),
			setupOidcSecret: (secret) => this.setupOidcSecret(secret),
			startOidc: (request, returnTo) => this.requireOidc().start(request, returnTo),
			finishOidc: async (request) => {
				const oidc = this.requireOidc()
				const result = await oidc.callback(request)
				if (result.ok === false) {
					return {
						ok: false as const,
						unavailable: result.reason === 'unavailable',
						clearStateCookie: oidc.stateClearCookie(),
					}
				}
				return {
					ok: true as const,
					cookie: this.sessions.create(result.principal, 'oidc'),
					clearStateCookie: oidc.stateClearCookie(),
					returnTo: result.returnTo,
				}
			},
			logout: (request, context) => {
				this.sessions.revoke(request, context.local)
				return clearSessionCookie(context.secure)
			},
		})
	}

	private async login(input: {
		username: string
		password: string
		otp?: string
		secure: boolean
	}): Promise<{ ok: true; cookie: string } | { ok: false; unavailable?: boolean }> {
		const mode = this.config.mode
		if (mode.type === 'oidc' || !this.ready()) return { ok: false, unavailable: true }
		const normalized = normalizeUsername(input.username) ?? ''
		const failureIdentity = normalized || '<invalid>'
		if (!this.loginFailures.allows(failureIdentity)) return { ok: false }
		const account = this.account
		const password = account?.password
		if (!password) return { ok: false, unavailable: true }
		try {
			const passwordMatches = await verifyPassword(input.password, password)
			const usernameMatchesAccount = account
				? usernameMatches(normalized, account.normalizedUsername)
				: false
			if (!passwordMatches || !usernameMatchesAccount || !account) {
				this.loginFailures.recordFailure(failureIdentity)
				return { ok: false }
			}
			if (mode.type === 'password-totp') {
				if (!input.otp || !(await this.consumeTotp(account, input.otp))) {
					this.loginFailures.recordFailure(failureIdentity)
					return { ok: false }
				}
			}
			const principal: AuthPrincipal = Object.freeze({
				subject: `local:${account.normalizedUsername}`,
				displayName: account.username,
			})
			this.loginFailures.clear(failureIdentity)
			return {
				ok: true,
				cookie: this.sessions.create(principal, mode.type, input.secure),
			}
		} catch {
			return { ok: false, unavailable: true }
		}
	}

	private async setupPassword(input: {
		username: string
		password: string
		passwordConfirmation: string
	}): Promise<SetupResult> {
		if (this.config.mode.type !== 'password') return failure('Password mode is not active.')
		const base = await this.prepareAccount(input)
		if ('ok' in base) return base
		await this.saveAccount({
			version: 1,
			type: 'local-account',
			username: base.username,
			normalizedUsername: base.normalizedUsername,
			password: base.password,
		})
		return { ok: true }
	}

	private async beginTotp(input: {
		username: string
		password: string
		passwordConfirmation: string
	}): Promise<TotpEnrollmentView | SetupResult> {
		if (this.config.mode.type !== 'password-totp') {
			return failure('Password and OTP mode is not active.')
		}
		const base = await this.prepareAccount(input)
		if ('ok' in base) return base
		this.pruneEnrollments()
		while (this.enrollments.size >= MAX_ENROLLMENTS) {
			const oldest = this.enrollments.keys().next().value as string | undefined
			if (!oldest) break
			this.enrollments.delete(oldest)
		}
		const id = randomBytes(24).toString('base64url')
		const secret = createTotpSecret()
		this.enrollments.set(id, {
			...base,
			secret,
			expiresAt: Date.now() + ENROLLMENT_TTL_MS,
			attempts: 0,
		})
		return Object.freeze({
			id,
			secret,
			provisioningUri: totpProvisioningUri({ secret, username: base.username }),
		})
	}

	private async confirmTotp(input: { enrollmentId: string; otp: string }): Promise<SetupResult> {
		if (!/^[A-Za-z0-9_-]{32}$/.test(input.enrollmentId)) {
			return failure('The OTP enrollment is invalid or expired.')
		}
		const enrollment = this.enrollments.get(input.enrollmentId)
		if (!enrollment || enrollment.expiresAt <= Date.now()) {
			this.enrollments.delete(input.enrollmentId)
			return failure('The OTP enrollment is invalid or expired.')
		}
		enrollment.attempts += 1
		if (enrollment.attempts > MAX_ENROLLMENT_ATTEMPTS) {
			this.enrollments.delete(input.enrollmentId)
			return failure('The OTP enrollment is invalid or expired.')
		}
		const counter = verifyTotp(input.otp, {
			secret: enrollment.secret,
			lastAcceptedCounter: -1,
		})
		if (counter === undefined) return failure('The one-time code was not accepted.')
		const totp: TotpRecord = {
			algorithm: 'sha1',
			digits: 6,
			period: 30,
			secret: enrollment.secret,
			lastAcceptedCounter: counter,
		}
		await this.saveAccount({
			version: 1,
			type: 'local-account',
			username: enrollment.username,
			normalizedUsername: enrollment.normalizedUsername,
			password: enrollment.password,
			totp,
		})
		this.enrollments.delete(input.enrollmentId)
		return { ok: true }
	}

	private async setupOidcSecret(secret: string): Promise<SetupResult> {
		const mode = this.config.mode
		if (mode.type !== 'oidc' || mode.clientKind !== 'confidential') {
			return failure('The configured OIDC client does not require a client secret.')
		}
		if (secret.length === 0 || secret.length > 4_096)
			return failure('The client secret is invalid.')
		const store = this.store
		if (!store?.available) return failure('Vault is unavailable.')
		await store.saveOidcSecret(secret)
		this.oidcSecret = secret
		this.oidcSecretInvalid = false
		this.sessions.clear()
		return { ok: true }
	}

	private async prepareAccount(input: {
		username: string
		password: string
		passwordConfirmation: string
	}): Promise<
		| Readonly<{ username: string; normalizedUsername: string; password: PasswordRecord }>
		| SetupResult
	> {
		const store = this.store
		if (!store?.available) return failure('Vault is unavailable.')
		const username = input.username.trim()
		const normalizedUsername = normalizeUsername(username)
		if (!normalizedUsername) {
			return failure('Account names may use letters, numbers, dot, underscore, @, and hyphen.')
		}
		if (input.password !== input.passwordConfirmation) return failure('Passwords do not match.')
		try {
			return Object.freeze({
				username,
				normalizedUsername,
				password: await hashPassword(input.password),
			})
		} catch (error) {
			return failure(
				error instanceof PasswordHashBusyError
					? 'Password hashing is temporarily busy.'
					: 'Use a password of at least 12 characters.',
			)
		}
	}

	private async saveAccount(account: LocalAccountRecord): Promise<void> {
		await this.persistAccount(account)
		this.sessions.clear()
	}

	private async persistAccount(account: LocalAccountRecord): Promise<void> {
		const store = this.store
		if (!store?.available) throw new Error('Vault is unavailable')
		await store.saveAccount(account)
		this.account = Object.freeze(account)
		this.accountInvalid = false
	}

	private consumeTotp(expected: LocalAccountRecord, token: string): Promise<boolean> {
		let resolveTurn!: () => void
		const previous = this.totpMutation
		this.totpMutation = new Promise<void>((resolve) => {
			resolveTurn = resolve
		})
		return previous.then(async () => {
			try {
				const current = this.account
				if (current !== expected || !current.totp) return false
				const counter = verifyTotp(token, current.totp)
				if (counter === undefined) return false
				await this.persistAccount({
					...current,
					totp: { ...current.totp, lastAcceptedCounter: counter },
				})
				return true
			} finally {
				resolveTurn()
			}
		})
	}

	private pruneEnrollments(): void {
		const now = Date.now()
		for (const [id, enrollment] of this.enrollments) {
			if (enrollment.expiresAt <= now) this.enrollments.delete(id)
		}
	}

	private requireHttp(): AuthHttpController {
		if (!this.active || !this.http) throw new Error('AuthPlugin is not running')
		return this.http
	}

	private requireOidc(): OidcClient {
		if (!this.active || !this.oidc) throw new Error('OIDC mode is not active')
		return this.oidc
	}
}
