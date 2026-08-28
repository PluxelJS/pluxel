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

export type ManagementAccessProviderDecision =
	| Readonly<{ allow: true; principal: ManagementAccessPrincipal }>
	| Readonly<{
			allow: false
			reason:
				| 'unavailable'
				| 'unauthenticated'
				| 'invalid_credentials'
				| 'forbidden'
				| 'secure_transport_required'
	  }>

export type ManagementAccessRequestContext = Readonly<{
	/** True only when the physical carrier is a loopback peer. */
	local: boolean
	/** True only when the trusted physical carrier itself is HTTPS. */
	secure: boolean
}>

/** One generation-owned implementation of remote Management authentication. */
export interface ManagementAccessProvider {
	/**
	 * A cheap, synchronous snapshot. It can be called concurrently and must never include secrets
	 * or raw identity claims. Throwing makes this provider temporarily unavailable.
	 */
	status(): ManagementAccessProviderStatus
	/**
	 * Authenticate one remote Management request. The Request contains the original URL, method,
	 * headers, and an owner-bound signal, but deliberately omits the operation body so an
	 * authentication provider cannot consume or inspect Management payloads. `request.signal` is
	 * cancelled when the client disconnects or this Plugin generation is withdrawn. Runtime rejects
	 * insecure remote requests before calling this method.
	 */
	authorize(
		request: Request,
		context: ManagementAccessRequestContext,
	): Promise<ManagementAccessProviderDecision>
	/**
	 * Optionally serve the Runtime-owned authentication entry point. The request URL path is
	 * relative to `/__pluxel/admin-access`. The same cancellation and generation-drain rules apply;
	 * a returned streaming body keeps the generation alive until the body settles.
	 */
	handle(request: Request, context: ManagementAccessRequestContext): Promise<Response | undefined>
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

export type AdminAccessRequestContext = Readonly<{
	request?: Request
}>

export type AdminAccessAuthorizeInput = AdminAccessRequestContext

export type AdminAccessOverview = Readonly<{
	policy: 'provider-or-local-recovery'
	provider: ManagementAccessProviderStatus | null
}>

export type AdminAccessEntryState =
	| Readonly<{ state: 'allowed' }>
	| Readonly<{ state: 'local_setup_required' }>
	| Readonly<{ state: 'login_required'; method: ManagementAccessMethod }>
	| Readonly<{ state: 'secure_transport_required' }>
	| Readonly<{ state: 'authentication_unavailable' }>
