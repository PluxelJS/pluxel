import type { PluginNodeAddress } from '../plugins/runtime/identity'

/** The callable Web Fetch contract, without runtime-specific static helpers. */
export type OutboundFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type OutboundHttpSettings = Readonly<{
	/** Omit to inherit. An empty list denies all managed requests in this scope. */
	allowedOrigins?: readonly string[]
	/** Per attempt, from admission to response headers. */
	timeoutMs?: number
	/** Defaults for headers absent from the caller's request. */
	headers?: Readonly<Record<string, string>>
	/** Omit to inherit, or use null to clear the managed proxy. */
	proxyUrl?: string | null
}>

/** Settings supplied by the Host before any saved policy is loaded. */
export type OutboundHttpOptions = OutboundHttpSettings &
	Readonly<{
		/** Trusted transport used after applying policy. Defaults to platform Fetch. */
		fetch?: OutboundFetch
		/** Default 64. */
		maxConcurrentRequests?: number
		/** Default 256. Zero disables queueing. */
		maxQueuedRequests?: number
		/** Allow saved overrides to select a proxy on supported hosts. */
		allowProxyChanges?: boolean
	}>

export type OutboundHttpEffectiveSettings = Readonly<{
	allowedOrigins?: readonly string[]
	timeoutMs: number
	headers: Readonly<Record<string, string>>
	proxyUrl: string | null
}>

export type OutboundHttpLimits = Readonly<{
	allowedOrigins?: readonly string[]
	timeoutMs: number
	maxConcurrentRequests: number
	maxQueuedRequests: number
	allowProxyChanges: boolean
}>

export type OutboundHttpActivity = Readonly<{
	owner: PluginNodeAddress
	lastAttemptAt: number
	lastOrigin: string
	received: number
	failed: number
	denied: number
	lastOutcome: 'response' | 'failed' | 'denied'
	lastStatus?: number
	lastCode?: string
}>

export type OutboundHttpSnapshot = Readonly<{
	revision: number
	owner: PluginNodeAddress | null
	settings: OutboundHttpSettings
	effective: OutboundHttpEffectiveSettings
	limits: OutboundHttpLimits
	activity: readonly OutboundHttpActivity[]
}>

export type OutboundHttpSaveResult = Readonly<{
	snapshot: OutboundHttpSnapshot
	cleanupError?: string
}>
