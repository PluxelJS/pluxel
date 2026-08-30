import {
	BasePlugin,
	Plugin,
	type ManagementAccessPrincipal,
	type ManagementAccessProvider,
	type ManagementAccessProviderStatus,
	type ManagementAccessRequestContext,
	type ManagementAuthenticationProviderSession,
	type ManagementAuthenticationProviderStep,
} from '@pluxel/runtime'
import {
	authenticatedSession,
	FixedAuthenticationSession,
	PasswordAuthenticationSession,
} from './challenge.ts'
import { AuthSetupTarget } from './auth-setup-target.ts'
import { AuthConfig, type AuthPluginConfig } from './config.ts'
import { handleCookieCommit } from './cookie-commit.ts'
import { CredentialStore, type LocalAccountRecord } from './credentials.ts'
import { CredentialProvisioning } from './credential-provisioning.ts'
import { LoginFailureLimiter } from './login-failures.ts'
import { OidcClient } from './oidc.ts'
import { verifyPassword } from './password.ts'
import { SessionStore } from './sessions.ts'
import { verifyTotp } from './totp.ts'
import { AuthWorkbench, type AuthCredentialSetupMode, type AuthSetupSnapshot } from './workbench.ts'

export { AuthConfig } from './config.ts'
export type { AuthPluginConfig, AuthMode, OidcAuthMode } from './config.ts'

const OIDC_START_PATH = '/__pluxel/admin-access/oidc/start' as const

function failed(code: 'access_unavailable'): FixedAuthenticationSession {
	return new FixedAuthenticationSession(Object.freeze({ kind: 'failed', code }))
}

function emptyResponse(status: number, cookies: readonly string[] = []): Response {
	const headers = new Headers({ 'cache-control': 'no-store' })
	for (const cookie of cookies) headers.append('set-cookie', cookie)
	return new Response(null, { status, headers })
}

function redirect(path: string, cookies: readonly string[]): Response {
	const headers = new Headers({ 'cache-control': 'no-store', location: path })
	for (const cookie of cookies) headers.append('set-cookie', cookie)
	return new Response(null, { status: 303, headers })
}

@Plugin({ displayName: 'Authentication' })
export class AuthPlugin extends BasePlugin {
	private readonly config: AuthPluginConfig = this.configs.use(AuthConfig)
	private readonly sessions = new SessionStore()
	private readonly loginFailures = new LoginFailureLimiter()
	private active = false
	private account?: LocalAccountRecord
	private oidcSecret?: string
	private accountInvalid = false
	private oidcSecretInvalid = false
	private oidc?: OidcClient
	private store?: CredentialStore
	private totpMutation: Promise<void> = Promise.resolve()
	private credentialMutation: Promise<void> = Promise.resolve()

	private readonly provider: ManagementAccessProvider = Object.freeze({
		status: (): ManagementAccessProviderStatus => this.providerStatus(),
		open: (
			request: Request,
			context: ManagementAccessRequestContext,
		): ManagementAuthenticationProviderSession => this.openAuthentication(request, context),
		oidcStart: (request: Request, context: ManagementAccessRequestContext): Promise<Response> =>
			this.startOidc(request, context),
		oidcCallback: (request: Request, context: ManagementAccessRequestContext): Promise<Response> =>
			this.finishOidc(request, context),
		commitCookie: (request: Request, context: ManagementAccessRequestContext): Promise<Response> =>
			this.commitCookie(request, context),
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
		if (mode.type === 'oidc') this.oidc = new OidcClient(mode, () => this.oidcSecret)

		this.active = true
		this.ctx.effects.defer(
			() => {
				this.active = false
				this.sessions.clear()
				this.loginFailures.clear()
				this.oidc?.clear()
				this.account = undefined
				this.oidcSecret = undefined
				this.oidc = undefined
				this.store = undefined
			},
			{ tag: 'auth-generation', phase: 'shutdown' },
		)
		this.ctx.managementAccess?.provide(this.provider)
		this.ctx.workbench?.publish(AuthWorkbench, {
			setup: ({ principal, signal }) =>
				this.createSetupTarget(principal.provider, principal.subject, signal),
		})
	}

	private providerStatus(): ManagementAccessProviderStatus {
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
		if (this.accountInvalid || !this.account) return false
		return mode.type === 'password' || Boolean(this.account.totp)
	}

	private setupSnapshot(): AuthSetupSnapshot {
		if (!this.active) throw new Error('AuthPlugin is not running')
		const mode = this.config.mode
		if (mode.type === 'oidc' && mode.clientKind === 'public') {
			return Object.freeze({ mode: 'oidc-public', state: 'configured' })
		}
		const setupMode: AuthCredentialSetupMode =
			mode.type === 'oidc' ? 'oidc-confidential' : mode.type
		if (!this.store?.available) {
			return Object.freeze({
				mode: setupMode,
				state: 'unavailable',
				reason: 'vault-unavailable',
			})
		}
		const invalid = mode.type === 'oidc' ? this.oidcSecretInvalid : this.accountInvalid
		if (invalid) {
			return Object.freeze({ mode: setupMode, state: 'setup-required', reason: 'invalid' })
		}
		const configured =
			mode.type === 'oidc'
				? Boolean(this.oidcSecret)
				: Boolean(this.account) && (mode.type === 'password' || Boolean(this.account?.totp))
		return configured
			? Object.freeze({ mode: setupMode, state: 'configured' })
			: Object.freeze({ mode: setupMode, state: 'setup-required', reason: 'missing' })
	}

	private createSetupTarget(
		principalProvider: string,
		principalSubject: string,
		signal: AbortSignal,
	): AuthSetupTarget {
		const store = this.store
		if (!this.active || !store) throw new Error('AuthPlugin is not running')
		const provisioning = new CredentialProvisioning(
			this.config.mode,
			store,
			(account) => {
				this.account = account
				this.accountInvalid = false
				this.sessions.clear()
			},
			(secret) => {
				this.oidcSecret = secret
				this.oidcSecretInvalid = false
				this.sessions.clear()
			},
		)
		return new AuthSetupTarget({
			authorized: principalProvider === 'local' && principalSubject === 'local',
			signal,
			provisioning,
			snapshot: () => this.setupSnapshot(),
			mutate: (operation) => this.runCredentialMutation(operation),
		})
	}

	private runCredentialMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
		const task = this.credentialMutation.then(operation)
		this.credentialMutation = task.then(
			(): undefined => undefined,
			(): undefined => undefined,
		)
		return task
	}

	private openAuthentication(
		request: Request,
		context: ManagementAccessRequestContext,
	): ManagementAuthenticationProviderSession {
		if (!this.ready() || (!context.secure && !context.local)) return failed('access_unavailable')
		const mode = this.config.mode
		const existing = this.sessions.read(request, mode.type, context.local)
		if (existing) {
			return authenticatedSession(existing, () => this.sessions.issueLogout(request, context.local))
		}
		if (mode.type === 'oidc') {
			return new FixedAuthenticationSession(
				Object.freeze({ kind: 'navigate', path: OIDC_START_PATH }),
			)
		}

		const account = this.account!
		const identity = account.normalizedUsername
		const principal: ManagementAccessPrincipal = Object.freeze({
			subject: `local:${identity}`,
			displayName: account.username,
		})
		let totpAccepted = false
		let issuedCommit:
			| Readonly<{
					commit: Readonly<{ ticket: string; expiresAt: number }>
					revoke(): void
			  }>
			| undefined
		return new PasswordAuthenticationSession({
			label: account.username,
			requireTotp: mode.type === 'password-totp',
			verifyPassword: async (password) => {
				if (!this.active || this.account !== account) return 'unavailable'
				if (!this.loginFailures.allows(identity)) return 'limited'
				try {
					const matches = await verifyPassword(password, account.password)
					if (!this.active || this.account !== account) return 'unavailable'
					if (matches) return 'accepted'
					this.loginFailures.recordFailure(identity)
					return 'rejected'
				} catch {
					return 'unavailable'
				}
			},
			verifyTotp: async (code) => {
				if (!this.active || this.account !== account) return 'unavailable'
				if (!this.loginFailures.allows(identity)) return 'limited'
				try {
					if (await this.consumeTotp(account, code)) {
						totpAccepted = true
						return 'accepted'
					}
					this.loginFailures.recordFailure(identity)
					return 'rejected'
				} catch {
					return 'unavailable'
				}
			},
			authenticated: (): ManagementAuthenticationProviderStep => {
				if (
					!this.active ||
					(mode.type === 'password'
						? this.account !== account
						: !totpAccepted || this.account?.normalizedUsername !== identity)
				) {
					return Object.freeze({ kind: 'failed', code: 'access_unavailable' })
				}
				this.loginFailures.clear(identity)
				issuedCommit = this.sessions.issueBoundCommit(principal, mode.type, context.secure)
				return Object.freeze({
					kind: 'authenticated',
					principal,
					cookieCommit: issuedCommit.commit,
				})
			},
			logout: () => {
				issuedCommit?.revoke()
				issuedCommit = undefined
				return (
					this.sessions.issueLogout(request, context.local) ??
					this.sessions.issueClearCookie(context.secure)
				)
			},
		})
	}

	private async startOidc(
		request: Request,
		context: ManagementAccessRequestContext,
	): Promise<Response> {
		if (
			!this.ready() ||
			this.config.mode.type !== 'oidc' ||
			!context.secure ||
			(request.method !== 'GET' && request.method !== 'HEAD')
		) {
			return emptyResponse(404)
		}
		try {
			return await this.requireOidc().start(request, '/')
		} catch {
			return emptyResponse(503)
		}
	}

	private async finishOidc(
		request: Request,
		context: ManagementAccessRequestContext,
	): Promise<Response> {
		if (
			!this.ready() ||
			this.config.mode.type !== 'oidc' ||
			!context.secure ||
			(request.method !== 'GET' && request.method !== 'HEAD')
		) {
			return emptyResponse(404)
		}
		const oidc = this.requireOidc()
		const result = await oidc.callback(request)
		if (result.ok === false) {
			return emptyResponse(result.reason === 'unavailable' ? 503 : 401, [oidc.stateClearCookie()])
		}
		return redirect(result.returnTo, [
			this.sessions.create(result.principal, 'oidc'),
			oidc.stateClearCookie(),
		])
	}

	private async commitCookie(
		request: Request,
		context: ManagementAccessRequestContext,
	): Promise<Response> {
		if (!this.active) return emptyResponse(404)
		return await handleCookieCommit(request, context, this.sessions)
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
				const store = this.store
				if (!store) return false
				await store.saveAccount({
					...current,
					totp: { ...current.totp, lastAcceptedCounter: counter },
				})
				this.account = Object.freeze({
					...current,
					totp: { ...current.totp, lastAcceptedCounter: counter },
				})
				return true
			} finally {
				resolveTurn()
			}
		})
	}

	private requireOidc(): OidcClient {
		if (!this.active || !this.oidc) throw new Error('OIDC mode is not active')
		return this.oidc
	}
}
