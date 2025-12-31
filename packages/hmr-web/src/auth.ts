export type AuthBlockedInfo = {
	status: number
	url: string
	redirectPath?: string
}

export type OnAuthBlocked = (info: AuthBlockedInfo) => void

export type AuthAwareFetchOptions = {
	/**
	 * Called when a response indicates auth is required/denied.
	 * Default behavior: if `redirectPath` exists, `window.location.assign(redirectPath)`.
	 */
	onBlocked?: OnAuthBlocked
	/**
	 * Only treat responses as "auth blocked" when this header is present.
	 * Defaults to `true` to avoid redirecting on unrelated 401/403 (e.g. 3rd-party APIs).
	 */
	requireMarkerHeader?: boolean
}

const AUTH_AWARE_FETCH = Symbol.for('pluxel.authAwareFetch')

/**
 * 重定向状态管理
 * 使用时间戳而非布尔值，带超时自动重置以处理重定向失败的情况
 */
let redirectingAt: number | null = null
const REDIRECT_TIMEOUT_MS = 3000 // 3 秒后如果页面还在则重置

function isRedirecting(): boolean {
	if (redirectingAt === null) return false
	// 超时自动重置
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

export function defaultOnAuthBlocked(info: AuthBlockedInfo) {
	if (typeof window === 'undefined') return
	if (!info.redirectPath) return
	if (isRedirecting()) return
	markRedirecting()
	window.location.assign(info.redirectPath)
}

export function isAuthBlockedResponse(res: Response, opts?: AuthAwareFetchOptions): boolean {
	const statusBlocked = res.status === 401 || res.status === 403
	if (!statusBlocked) return false
	const requireMarkerHeader = opts?.requireMarkerHeader ?? true
	if (!requireMarkerHeader) return true
	return res.headers.get('X-Pluxel-Auth-Blocked') === '1'
}

export async function extractRedirectPath(res: Response): Promise<string | undefined> {
	const header =
		res.headers.get('X-Pluxel-Redirect-Path') ?? res.headers.get('x-pluxel-redirect-path')
	if (header) return header

	const ct = (res.headers.get('content-type') ?? '').toLowerCase()
	if (!ct.includes('application/json')) return undefined

	try {
		const payload = (await res.clone().json()) as any
		return payload?.redirectPath ?? payload?.extensions?.redirectPath
	} catch {
		return undefined
	}
}

export function createAuthAwareFetch(
	baseFetch: typeof fetch,
	options: AuthAwareFetchOptions = {},
): typeof fetch {
	if ((baseFetch as any)?.[AUTH_AWARE_FETCH]) return baseFetch

	const onBlocked = options.onBlocked ?? defaultOnAuthBlocked
	const requireMarkerHeader = options.requireMarkerHeader ?? true

	const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await baseFetch(input as any, init)
		if (!isAuthBlockedResponse(res, { requireMarkerHeader })) return res

		const redirectPath = await extractRedirectPath(res)
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url

		onBlocked({ status: res.status, url, redirectPath })
		return res
	}) as any

	;(wrapped as any)[AUTH_AWARE_FETCH] = true
	return wrapped
}

type InstallGlobalAuthFetchOptions = AuthAwareFetchOptions & {
	enabled?: boolean
}

let installCount = 0
let originalFetch: typeof fetch | null = null

export function installGlobalAuthFetch(options: InstallGlobalAuthFetchOptions = {}): () => void {
	if (options.enabled === false) return () => {}
	if (typeof globalThis.fetch !== 'function') return () => {}

	if (installCount === 0) {
		originalFetch = globalThis.fetch.bind(globalThis)
		globalThis.fetch = createAuthAwareFetch(originalFetch, options)
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
