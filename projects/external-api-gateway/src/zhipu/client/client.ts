import { DEFAULT_ZHIPU_BASE_URL, DEFAULT_ZHIPU_TIMEOUT_MS } from '../../constants.ts'

export type ZhipuClientOptions = {
	apiKey: string
	baseUrl?: string
	fetch?: typeof fetch
	timeoutMs?: number
}

export type ZhipuRawRequestOptions = {
	method: string
	path: string
	body?: BodyInit | Record<string, unknown> | null
	headers?: HeadersInit
	timeoutMs?: number
}

function trimRightSlash(input: string): string {
	return input.replace(/\/+$/, '')
}

function trimLeftSlash(input: string): string {
	return input.replace(/^\/+/, '')
}

function normalizeOpenApiPath(path: string): string {
	const trimmed = trimLeftSlash(path)
	return trimmed.startsWith('paas/v4/') ? trimmed.slice('paas/v4/'.length) : trimmed
}

function isJsonObject(body: ZhipuRawRequestOptions['body']): body is Record<string, unknown> {
	if (!body || typeof body !== 'object') return false
	if (typeof FormData !== 'undefined' && body instanceof FormData) return false
	if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false
	if (typeof Blob !== 'undefined' && body instanceof Blob) return false
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false
	return true
}

export class ZhipuClient {
	readonly baseUrl: string
	private readonly apiKey: string
	private readonly fetchImpl: typeof fetch
	private readonly timeoutMs: number

	constructor(options: ZhipuClientOptions) {
		this.baseUrl = trimRightSlash(options.baseUrl ?? DEFAULT_ZHIPU_BASE_URL)
		this.apiKey = options.apiKey
		this.fetchImpl = options.fetch ?? globalThis.fetch
		this.timeoutMs = Math.max(0, Number(options.timeoutMs ?? DEFAULT_ZHIPU_TIMEOUT_MS) || 0)
		if (!this.fetchImpl) throw new Error('No fetch implementation found')
	}

	url(path: string): URL {
		return new URL(`${this.baseUrl}/${normalizeOpenApiPath(path)}`)
	}

	async raw(options: ZhipuRawRequestOptions): Promise<Response> {
		const headers = new Headers(options.headers)
		if (!headers.has('authorization')) headers.set('authorization', `Bearer ${this.apiKey}`)
		if (isJsonObject(options.body) && !headers.has('content-type')) {
			headers.set('content-type', 'application/json')
		}
		const timeoutMs = Math.max(0, Number(options.timeoutMs ?? this.timeoutMs) || 0)
		const controller = timeoutMs > 0 ? new AbortController() : undefined
		const timeout =
			controller && timeoutMs > 0
				? setTimeout(
						() => controller.abort(new Error(`Zhipu request timed out after ${timeoutMs}ms`)),
						timeoutMs,
					)
				: undefined

		const init: RequestInit = {
			method: options.method.toUpperCase(),
			headers,
			...(controller ? { signal: controller.signal } : {}),
		}
		if (isJsonObject(options.body)) init.body = JSON.stringify(options.body)
		else if (options.body !== undefined) init.body = options.body

		try {
			return await this.fetchImpl(this.url(options.path), init)
		} finally {
			if (timeout) clearTimeout(timeout)
		}
	}
}

export function createZhipuClient(options: ZhipuClientOptions): ZhipuClient {
	return new ZhipuClient(options)
}
