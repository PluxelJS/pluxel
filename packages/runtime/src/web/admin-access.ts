import {
	ADMIN_ACCESS_BLOCKED_HEADER,
	ADMIN_ACCESS_REASON_HEADER,
	ADMIN_ACCESS_REDIRECT_HEADER,
	type AdminAccessReason,
} from '../shared/admin-access-http'

type RuntimeFetchPreconnect = typeof globalThis.fetch extends { preconnect: infer T }
	? T
	: (url: string | URL) => void

export type RuntimeFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
	preconnect?: RuntimeFetchPreconnect
}

export type AdminAccessBlockedInfo = {
	status: number
	url: string
	redirectPath?: string
	reason?: AdminAccessReason
}

export type OnAdminAccessBlocked = (info: AdminAccessBlockedInfo) => void

export type AdminAccessAwareFetchOptions = {
	onBlocked?: OnAdminAccessBlocked
}

const ADMIN_ACCESS_AWARE_FETCH = Symbol.for('pluxel.adminAccessAwareFetch')
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

export function defaultOnAdminAccessBlocked(info: AdminAccessBlockedInfo) {
	if (typeof window === 'undefined') return
	if (!info.redirectPath) return
	if (isRedirecting()) return
	markRedirecting()
	window.location.assign(info.redirectPath)
}

export function isAdminAccessBlockedResponse(res: Response): boolean {
	const statusBlocked = res.status === 401 || res.status === 403
	if (!statusBlocked) return false
	return res.headers.get(ADMIN_ACCESS_BLOCKED_HEADER) === '1'
}

export async function extractBlockedInfo(
	res: Response,
): Promise<Pick<AdminAccessBlockedInfo, 'redirectPath' | 'reason'>> {
	const header = res.headers.get(ADMIN_ACCESS_REDIRECT_HEADER)
	const reason =
		(res.headers.get(ADMIN_ACCESS_REASON_HEADER) as AdminAccessReason | null) ?? undefined
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

export function createAdminAccessAwareFetch(
	baseFetch: RuntimeFetch,
	options: AdminAccessAwareFetchOptions = {},
): RuntimeFetch {
	if ((baseFetch as any)?.[ADMIN_ACCESS_AWARE_FETCH]) return baseFetch

	const onBlocked = options.onBlocked ?? defaultOnAdminAccessBlocked

	const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await baseFetch(input as any, init)
		if (!isAdminAccessBlockedResponse(res)) return res

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

	;(wrapped as any)[ADMIN_ACCESS_AWARE_FETCH] = true
	wrapped.preconnect = resolvePreconnect(baseFetch)
	return wrapped
}

type InstallGlobalAdminAccessFetchOptions = AdminAccessAwareFetchOptions & {
	enabled?: boolean
}

let installCount = 0
let originalFetch: RuntimeFetch | null = null

export function installGlobalAdminAccessFetch(
	options: InstallGlobalAdminAccessFetchOptions = {},
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
		globalThis.fetch = toGlobalFetch(createAdminAccessAwareFetch(originalFetch, options))
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
