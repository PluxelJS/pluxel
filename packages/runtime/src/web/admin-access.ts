import {
	ADMIN_ACCESS_BLOCKED_HEADER,
	ADMIN_ACCESS_REASON_HEADER,
	ADMIN_ACCESS_REDIRECT_HEADER,
	type AdminAccessReason,
} from '../shared/admin-access-http'
import { RUNTIME_ADMIN_ACCESS_BASE } from './paths'

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

export function defaultOnAdminAccessBlocked(info: AdminAccessBlockedInfo) {
	if (typeof window === 'undefined') return
	if (!info.redirectPath) return
	const redirectPath = safeRedirectPath(info.redirectPath, window.location.href)
	if (!redirectPath) return
	if (isRedirecting()) return
	markRedirecting()
	window.location.assign(redirectPath)
}

export function isAdminAccessBlockedResponse(res: Response): boolean {
	const statusBlocked = res.status === 401 || res.status === 403 || res.status === 503
	if (!statusBlocked) return false
	return res.headers.get(ADMIN_ACCESS_BLOCKED_HEADER) === '1'
}

export async function extractBlockedInfo(
	res: Response,
): Promise<Pick<AdminAccessBlockedInfo, 'redirectPath' | 'reason'>> {
	const reason = parseReason(res.headers.get(ADMIN_ACCESS_REASON_HEADER))
	const header = safeRedirectPath(res.headers.get(ADMIN_ACCESS_REDIRECT_HEADER), res.url)
	if (header) return { redirectPath: header, reason }

	const ct = (res.headers.get('content-type') ?? '').toLowerCase()
	if (!ct.includes('application/json')) return { redirectPath: undefined, reason }

	try {
		const payload = (await res.clone().json()) as any
		return {
			redirectPath: safeRedirectPath(payload?.redirectPath, res.url),
			reason: parseReason(payload?.reason) ?? reason,
		}
	} catch {
		return { redirectPath: undefined, reason }
	}
}

function parseReason(value: unknown): AdminAccessReason | undefined {
	return value === 'local_setup_required' ||
		value === 'authentication_required' ||
		value === 'invalid_credentials' ||
		value === 'forbidden' ||
		value === 'secure_transport_required' ||
		value === 'authentication_unavailable'
		? value
		: undefined
}

function safeRedirectPath(value: unknown, base: string): string | undefined {
	if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\')) return undefined
	try {
		const fallback =
			base || (typeof window !== 'undefined' ? window.location.href : 'http://pluxel.invalid/')
		const origin = new URL(fallback).origin
		const resolved = new URL(value, fallback)
		if (resolved.origin !== origin || resolved.pathname !== RUNTIME_ADMIN_ACCESS_BASE) {
			return undefined
		}
		return `${resolved.pathname}${resolved.search}`
	} catch {
		return undefined
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
