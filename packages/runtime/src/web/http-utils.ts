import type { RuntimeFetch } from './admin-access'

export function withMethod(init: RequestInit | undefined, method: string): RequestInit {
	return { ...init, method }
}

export function withJsonBody(
	init: RequestInit | undefined,
	body: unknown,
	method = 'POST',
): RequestInit {
	const headers = new Headers(init?.headers)
	if (!headers.has('content-type')) headers.set('content-type', 'application/json')
	if (!headers.has('accept')) headers.set('accept', 'application/json')
	return {
		...init,
		method,
		headers,
		body: JSON.stringify(body),
	}
}

export async function requestJson<T>(
	fetch: RuntimeFetch,
	url: string,
	init?: RequestInit,
): Promise<T> {
	const headers = new Headers(init?.headers)
	if (!headers.has('accept')) headers.set('accept', 'application/json')
	const res = await fetch(url, { ...init, headers })
	if (!res.ok) throw await createHttpError(res)
	const payload = await res.text()
	if (!payload) throw new Error('Empty response')
	return JSON.parse(payload) as T
}

export async function createHttpError(res: Response): Promise<Error> {
	const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
	if (contentType.includes('application/json')) {
		try {
			const payload = (await res.json()) as { message?: unknown; code?: unknown }
			if (typeof payload.message === 'string' && payload.message) return new Error(payload.message)
			if (typeof payload.code === 'string' && payload.code) return new Error(payload.code)
		} catch {}
	}
	const bodyText = await res.text().catch(() => '')
	const text = bodyText.trim()
	return new Error(text || `HTTP ${res.status}`)
}

function isAbsoluteUrl(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)
}

export function resolveClientUrl(value: string): string {
	if (isAbsoluteUrl(value)) return value
	if (typeof window === 'undefined') return value
	return new URL(value, window.location.origin).toString()
}
