import {
	type ManagementAccessReason,
	VERIFICATION_BLOCKED_HEADER,
	VERIFICATION_REASON_HEADER,
	VERIFICATION_REDIRECT_HEADER,
} from '../shared/verification-http'

type RuntimeFetchPreconnect = typeof globalThis.fetch extends { preconnect: infer T }
	? T
	: (url: string | URL) => void

export type RuntimeFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
	preconnect?: RuntimeFetchPreconnect
}

export type ManagementAccessBlockedInfo = {
	status: number
	url: string
	redirectPath?: string
	reason?: ManagementAccessReason
}

export type OnManagementAccessBlocked = (info: ManagementAccessBlockedInfo) => void

export type ManagementAccessAwareFetchOptions = {
	onBlocked?: OnManagementAccessBlocked
}

export type VerificationBlockedInfo = ManagementAccessBlockedInfo
export type OnVerificationBlocked = OnManagementAccessBlocked
export type VerificationAwareFetchOptions = ManagementAccessAwareFetchOptions

const VERIFICATION_AWARE_FETCH = Symbol.for('pluxel.verificationAwareFetch')
const noopPreconnect = (() => {}) as RuntimeFetchPreconnect

function resolvePreconnect(fetch: RuntimeFetch): RuntimeFetchPreconnect {
	return (
		fetch.preconnect ??
		(typeof globalThis.fetch === 'function' && 'preconnect' in globalThis.fetch
			? (globalThis.fetch.preconnect as RuntimeFetchPreconnect)
			: noopPreconnect)
	)
}

export function toGlobalFetch(fetch: RuntimeFetch): typeof globalThis.fetch {
	const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
		fetch(input, init)) as typeof globalThis.fetch
	wrapped.preconnect = resolvePreconnect(fetch)
	return wrapped
}

let redirectingAt: number | null = null
const REDIRECT_TIMEOUT_MS = 3000

function isRedirecting(): boolean {
	if (redirectingAt === null) return false
	if (Date.now() - redirectingAt > REDIRECT_TIMEOUT_MS) {
		redirectingAt = null
		return false
	}
	return true
}

function markRedirecting(): void {
	redirectingAt = Date.now()
}

export function resetRedirectingState(): void {
	redirectingAt = null
}

export function defaultOnManagementAccessBlocked(info: ManagementAccessBlockedInfo) {
	if (typeof window === 'undefined') return
	if (!info.redirectPath) return
	if (isRedirecting()) return
	markRedirecting()
	window.location.assign(info.redirectPath)
}

export function isVerificationBlockedResponse(res: Response): boolean {
	const statusBlocked = res.status === 401 || res.status === 403
	if (!statusBlocked) return false
	return res.headers.get(VERIFICATION_BLOCKED_HEADER) === '1'
}

export async function extractBlockedInfo(
	res: Response,
): Promise<Pick<ManagementAccessBlockedInfo, 'redirectPath' | 'reason'>> {
	const header = res.headers.get(VERIFICATION_REDIRECT_HEADER)
	const reason =
		(res.headers.get(VERIFICATION_REASON_HEADER) as ManagementAccessReason | null) ?? undefined
	if (header) return { redirectPath: header, reason }

	const ct = (res.headers.get('content-type') ?? '').toLowerCase()
	if (!ct.includes('application/json')) return { redirectPath: undefined, reason }

	try {
		const payload = (await res.clone().json()) as any
		return {
			redirectPath: payload?.redirectPath,
			reason: payload?.reason,
		}
	} catch {
		return { redirectPath: undefined, reason }
	}
}

export function createManagementAccessAwareFetch(
	baseFetch: RuntimeFetch,
	options: ManagementAccessAwareFetchOptions = {},
): RuntimeFetch {
	if ((baseFetch as any)?.[VERIFICATION_AWARE_FETCH]) return baseFetch

	const onBlocked = options.onBlocked ?? defaultOnManagementAccessBlocked

	const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await baseFetch(input as any, init)
		if (!isVerificationBlockedResponse(res)) return res

		const blocked = await extractBlockedInfo(res)
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url

		onBlocked({
			status: res.status,
			url,
			redirectPath: blocked.redirectPath,
			reason: blocked.reason,
		})
		return res
	}) as RuntimeFetch

	;(wrapped as any)[VERIFICATION_AWARE_FETCH] = true
	wrapped.preconnect = resolvePreconnect(baseFetch)
	return wrapped
}

export const defaultOnVerificationBlocked = defaultOnManagementAccessBlocked
export const createVerificationAwareFetch = createManagementAccessAwareFetch

type InstallGlobalVerificationFetchOptions = ManagementAccessAwareFetchOptions & {
	enabled?: boolean
}

let installCount = 0
let originalFetch: RuntimeFetch | null = null

export function installGlobalVerificationFetch(
	options: InstallGlobalVerificationFetchOptions = {},
): () => void {
	if (options.enabled === false) return () => {}
	if (typeof globalThis.fetch !== 'function') return () => {}

	if (installCount === 0) {
		const nativeFetch = globalThis.fetch as typeof globalThis.fetch
		originalFetch = nativeFetch.bind(globalThis) as RuntimeFetch
		originalFetch.preconnect =
			'preconnect' in nativeFetch
				? (nativeFetch.preconnect as RuntimeFetchPreconnect)
				: noopPreconnect
		globalThis.fetch = toGlobalFetch(createManagementAccessAwareFetch(originalFetch, options))
	}
	installCount++

	return () => {
		installCount = Math.max(0, installCount - 1)
		if (installCount !== 0) return
		if (originalFetch) globalThis.fetch = originalFetch
		originalFetch = null
		resetRedirectingState()
	}
}
