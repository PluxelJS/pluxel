export type ManagementAccessMethod = 'oidc' | 'password' | 'password-totp'

export type ManagementAccessProviderStatus = Readonly<{
	id: string
	label: string
	method: ManagementAccessMethod
	ready: boolean
}>

export type ManagementAccessPrincipal = Readonly<{
	subject: string
	displayName?: string
}>

export type ManagementAuthenticationChallenge =
	| Readonly<{ kind: 'password'; label?: string }>
	| Readonly<{ kind: 'totp'; digits: 6 }>

export type ManagementAuthenticationFailureCode =
	| 'authentication_failed'
	| 'authentication_expired'
	| 'access_unavailable'
	| 'attempt_limited'

export type ManagementAuthenticationProviderStep =
	| Readonly<{ kind: 'challenge'; challenge: ManagementAuthenticationChallenge }>
	| Readonly<{ kind: 'navigate'; path: '/__pluxel/admin-access/oidc/start' }>
	| Readonly<{
			kind: 'authenticated'
			principal: ManagementAccessPrincipal
			cookieCommit?: Readonly<{ ticket: string; expiresAt: number }>
	  }>
	| Readonly<{ kind: 'failed'; code: ManagementAuthenticationFailureCode }>

export type ManagementAuthenticationCookieCommit = Readonly<{
	ticket: string
	expiresAt: number
}>

export interface ManagementAuthenticationProviderSession extends Disposable {
	state(): ManagementAuthenticationProviderStep | Promise<ManagementAuthenticationProviderStep>
	submit(
		input: unknown,
	): ManagementAuthenticationProviderStep | Promise<ManagementAuthenticationProviderStep>
	/** Optional provider-owned revocation for the credential captured by open(). */
	logout?():
		| ManagementAuthenticationCookieCommit
		| undefined
		| Promise<ManagementAuthenticationCookieCommit | undefined>
}

export type ManagementAccessRequestContext = Readonly<{
	/** True only when the physical carrier is a loopback peer. */
	local: boolean
	/** True only when the trusted physical carrier itself is HTTPS. */
	secure: boolean
}>

/** One generation-owned implementation of Management authentication. */
export interface ManagementAccessProvider {
	/** Cheap synchronous status. `ready:false` is a real unavailable state, not a login challenge. */
	status(): ManagementAccessProviderStatus
	/**
	 * Open one connection-bound authentication flow. The Request contains only URL, headers and
	 * the owner/session signal; it never contains a Management operation body.
	 */
	open(
		request: Request,
		context: ManagementAccessRequestContext,
	): ManagementAuthenticationProviderSession | Promise<ManagementAuthenticationProviderSession>
	/** Exact top-level OIDC navigation entry. No Management payload is served here. */
	oidcStart?(request: Request, context: ManagementAccessRequestContext): Promise<Response>
	/** Exact OIDC callback entry. It may commit an HttpOnly cookie and redirect. */
	oidcCallback?(request: Request, context: ManagementAccessRequestContext): Promise<Response>
	/** Consume one short-lived, single-use ticket and commit an HttpOnly cookie. */
	commitCookie?(request: Request, context: ManagementAccessRequestContext): Promise<Response>
}

export interface ManagementAccessRegistration {
	/** Idempotently withdraw this provider. Owner cleanup also withdraws it automatically. */
	dispose(): void
}

export type AdminAccessReason =
	| 'local_setup_required'
	| 'authentication_required'
	| 'invalid_credentials'
	| 'forbidden'
	| 'secure_transport_required'
	| 'authentication_unavailable'

export type AdminAccessPrincipal = Readonly<{
	provider: string
	subject: string
	displayName?: string
}>

export type AdminAccessState =
	| Readonly<{ allow: true; method: 'local' }>
	| Readonly<{ allow: true; method: 'provider'; principal: AdminAccessPrincipal }>
	| Readonly<{ allow: false; reason: AdminAccessReason }>

export type AdminAccessOverview = Readonly<{
	policy: 'provider-or-local-recovery'
	provider: ManagementAccessProviderStatus | null
}>
