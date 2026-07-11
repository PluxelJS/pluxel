import { KOOK_ENDPOINTS } from './endpoints.ts'
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
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export type KookRawApi = {
	request: KookRequest
	call<K extends keyof KookAutoApi>(
		endpoint: K,
		payload?: Parameters<KookAutoApi[K]>[0],
	): ReturnType<KookAutoApi[K]>
}

type EndpointMeta = {
	method: HttpMethod
	path: string
	query: boolean
}

export function createKookClient(options: KookClientOptions): KookApi {
	const token = options.token.trim()
	if (!token) throw new Error('KOOK client requires a Bot token')
	const baseUrl = (options.baseUrl?.trim() || 'https://www.kookapp.cn').replace(/\/+$/, '')
	const apiPrefix = normalizePrefix(options.apiPrefix ?? '/api/v3')
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
	const endpointMap = new Map<string, EndpointMeta>(
		KOOK_ENDPOINTS.map(([name, method, path]) => [name, { method, path, query: method === 'GET' }]),
	)

	const request: KookRequest = async <T>(
		method: HttpMethod,
		path: string,
		payload?: RequestPayload,
	): Promise<Result<T>> => {
		try {
			const query = cleanParams(payload?.searchParams)
			const url = new URL(`${baseUrl}${apiPrefix}${normalizePath(path)}`)
			for (const [key, value] of Object.entries(query ?? {})) appendQuery(url, key, value)
			const body = payload?.body ?? payload?.json
			const response = await fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bot ${token}`,
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

	const raw: KookRawApi = {
		request,
		call(endpoint, payload) {
			const meta = endpointMap.get(String(endpoint))
			if (!meta) {
				return Promise.resolve({
					ok: false,
					code: -404,
					message: `Unknown KOOK endpoint: ${String(endpoint)}`,
				}) as ReturnType<KookAutoApi[typeof endpoint]>
			}
			return request(
				meta.method,
				meta.path,
				meta.query
					? { searchParams: payload as Record<string, unknown> }
					: isBodyInit(payload)
						? { body: payload }
						: { json: payload as JsonLike },
			) as ReturnType<KookAutoApi[typeof endpoint]>
		},
	}

	const target = { $raw: raw } as KookApi
	const client = new Proxy(target, {
		get(object, property, receiver) {
			if (Reflect.has(object, property)) return Reflect.get(object, property, receiver)
			if (typeof property !== 'string' || !endpointMap.has(property)) return undefined
			return (payload?: unknown) => raw.call(property as keyof KookAutoApi, payload as never)
		},
	})
	client.$tool = createKookTools(client)
	return client
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
