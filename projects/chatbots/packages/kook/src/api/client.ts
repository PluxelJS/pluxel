import { KOOK_ENDPOINTS } from './endpoints.ts'
import { invokeKookNative, KookNativeApi } from './native.ts'
import { createKookTools } from './tools.ts'
import type {
	Err,
	HttpMethod,
	IBaseAPIResponse,
	JsonLike,
	KookApi,
	KookAutoApi,
	KookRequest,
	RequestPayload,
	Result,
} from './types.ts'

export type KookClientOptions = {
	token: string
	/** @default "https://www.kookapp.cn" */
	baseUrl?: string
	/** @default "/api/v3" */
	apiPrefix?: string
	/** Aborts every request owned by this client instance. */
	signal?: AbortSignal
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export type KookRawApi = {
	request: KookRequest
	call<K extends keyof KookAutoApi>(
		endpoint: K,
		payload?: Parameters<KookAutoApi[K]>[0],
		signal?: AbortSignal,
	): ReturnType<KookAutoApi[K]>
}

type EndpointMeta = {
	method: HttpMethod
	path: string
	query: boolean
}

const endpointMap = new Map<string, EndpointMeta>(
	KOOK_ENDPOINTS.map(([name, method, path]) => [
		name,
		{ method, path, query: method === 'GET' || method === 'DELETE' },
	]),
)

export class KookApiClient extends KookNativeApi {
	readonly $raw: KookRawApi
	readonly $tool: KookApi['$tool']
	readonly #options: KookClientOptions
	readonly #token: string
	readonly #baseUrl: string
	readonly #apiPrefix: string
	readonly #fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
	readonly #lifecycle = new AbortController()

	constructor(options: KookClientOptions) {
		super()
		this.#options = options
		this.#token = options.token.trim()
		if (!this.#token) throw new Error('KOOK client requires a Bot token')
		this.#baseUrl = (options.baseUrl?.trim() || 'https://www.kookapp.cn').replace(/\/+$/, '')
		this.#apiPrefix = normalizePrefix(options.apiPrefix ?? '/api/v3')
		this.#fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
		this.$raw = {
			request: (method, path, payload, signal) => this.request(method, path, payload, signal),
			call: (endpoint, payload, signal) => this.call(endpoint, payload, signal) as never,
		}
		this.$tool = createKookTools(this)
	}

	async request<T>(
		method: HttpMethod,
		path: string,
		payload?: RequestPayload,
		signal?: AbortSignal,
	): Promise<Result<T>> {
		try {
			const query = cleanParams(payload?.searchParams)
			const url = new URL(`${this.#baseUrl}${this.#apiPrefix}${normalizePath(path)}`)
			for (const [key, value] of Object.entries(query ?? {})) appendQuery(url, key, value)
			const body = payload?.body ?? payload?.json
			const response = await this.#fetchImpl(url, {
				method,
				signal: combineSignals(this.#lifecycle.signal, this.#options.signal, signal),
				headers: {
					Authorization: `Bot ${this.#token}`,
					...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
				},
				...(method === 'GET' || method === 'HEAD'
					? {}
					: { body: isBodyInit(body) ? body : JSON.stringify(body ?? {}) }),
			})
			const envelope = (await response.json()) as IBaseAPIResponse<T>
			if (!response.ok || envelope.code !== 0) {
				return {
					ok: false,
					code: envelope.code || response.status,
					message: envelope.message || response.statusText || 'KOOK API request failed',
				}
			}
			return { ok: true, data: envelope.data }
		} catch (error) {
			return toRequestError(error)
		}
	}

	protected closeClient(reason?: unknown): void {
		if (!this.#lifecycle.signal.aborted) this.#lifecycle.abort(reason)
	}

	call<K extends keyof KookAutoApi>(
		endpoint: K,
		payload?: Parameters<KookAutoApi[K]>[0],
		signal?: AbortSignal,
	): ReturnType<KookAutoApi[K]> {
		const meta = endpointMap.get(String(endpoint))
		if (!meta)
			return Promise.resolve({
				ok: false,
				code: -404,
				message: `Unknown KOOK endpoint: ${String(endpoint)}`,
			}) as ReturnType<KookAutoApi[K]>
		return this.request(
			meta.method,
			meta.path,
			meta.query
				? { searchParams: payload as Record<string, unknown> }
				: isBodyInit(payload)
					? { body: payload }
					: { json: payload as JsonLike },
			signal,
		) as ReturnType<KookAutoApi[K]>
	}

	protected [invokeKookNative](endpoint: keyof KookAutoApi, payload?: unknown): unknown {
		return this.call(endpoint, payload as never)
	}
}

export function createKookClient(options: KookClientOptions): KookApi {
	return new KookApiClient(options)
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))]
	if (active.length === 0) return undefined
	return active.length === 1 ? active[0] : AbortSignal.any(active)
}

function normalizePrefix(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, '')
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizePath(value: string): string {
	return value.startsWith('/') ? value : `/${value}`
}

function cleanParams(input?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!input) return undefined
	const output = Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	)
	return Object.keys(output).length === 0 ? undefined : output
}

function appendQuery(url: URL, key: string, value: unknown): void {
	if (value === undefined || value === null) return
	if (Array.isArray(value)) {
		for (const item of value) url.searchParams.append(key, serializeQuery(item))
		return
	}
	url.searchParams.append(key, serializeQuery(value))
}

function serializeQuery(value: unknown): string {
	return value instanceof Date ? value.toISOString() : String(value)
}

function isBodyInit(value: unknown): value is BodyInit {
	return (
		typeof value === 'string' ||
		value instanceof FormData ||
		value instanceof Blob ||
		value instanceof URLSearchParams ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	)
}

function toRequestError(error: unknown): Err {
	return {
		ok: false,
		code: -1,
		message: error instanceof Error ? error.message : String(error),
	}
}
