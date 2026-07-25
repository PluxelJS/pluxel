import { KOOK_ENDPOINTS } from './endpoints.ts'
import type { Wretch } from '@pluxel/wretch'
import { RetryGate } from '@repo/chatbots-platform-kit/retry-gate'
import { invokeKookNative, KookNativeApi } from './native.ts'
import type {
	Err,
	HttpMethod,
	IBaseAPIResponse,
	JsonLike,
	KookApi,
	KookAutoApi,
	KookCallOptions,
	KookRequest,
	RequestPayload,
	Result,
} from './types.ts'

export type KookClientOptions = {
	http: Wretch
	token: string
	/** @default "https://www.kookapp.cn" */
	baseUrl?: string
	/** @default "/api/v3" */
	apiPrefix?: string
	/** Aborts every request owned by this client instance. */
	signal?: AbortSignal
}

export type KookRawApi = {
	request: KookRequest
	call<K extends keyof KookAutoApi>(
		endpoint: K,
		...args: KookRawCallArgs<K>
	): ReturnType<KookAutoApi[K]>
}

export type KookRawCallArgs<K extends keyof KookAutoApi> = undefined extends Parameters<
	KookAutoApi[K]
>[0]
	? [payload?: Parameters<KookAutoApi[K]>[0], options?: KookCallOptions]
	: [payload: Parameters<KookAutoApi[K]>[0], options?: KookCallOptions]

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
	readonly $: Readonly<{ raw: KookRawApi }>
	readonly #options: KookClientOptions
	readonly #token: string
	readonly #baseUrl: string
	readonly #apiPrefix: string
	readonly #http: Wretch
	readonly #retryGate = new RetryGate()

	constructor(options: KookClientOptions) {
		super()
		this.#options = options
		this.#token = options.token.trim()
		if (!this.#token) throw new Error('KOOK client requires a Bot token')
		this.#baseUrl = (options.baseUrl?.trim() || 'https://www.kookapp.cn').replace(/\/+$/, '')
		this.#apiPrefix = normalizePrefix(options.apiPrefix ?? '/api/v3')
		this.#http = options.http.auth(`Bot ${this.#token}`).accept('application/json')
		const raw: KookRawApi = {
			request: <T>(
				method: HttpMethod,
				path: string,
				payload?: RequestPayload,
				callOptions?: KookCallOptions,
			) => this.requestRaw<T>(method, path, payload, callOptions),
			call: <K extends keyof KookAutoApi>(endpoint: K, ...args: KookRawCallArgs<K>) =>
				this.callEndpoint(endpoint, ...args),
		}
		this.$ = Object.freeze({ raw: Object.freeze(raw) })
	}

	private async requestRaw<T>(
		method: HttpMethod,
		path: string,
		payload?: RequestPayload,
		callOptions?: KookCallOptions,
	): Promise<Result<T>> {
		try {
			const requestSignal = combineSignals(this.#options.signal, callOptions?.signal)
			await this.#retryGate.wait(requestSignal)
			const query = cleanParams(payload?.searchParams)
			const url = new URL(`${this.#baseUrl}${this.#apiPrefix}${normalizePath(path)}`)
			for (const [key, value] of Object.entries(query ?? {})) appendQuery(url, key, value)
			const body = payload?.body ?? payload?.json
			let request = this.#http.url(url.toString(), true)
			if (requestSignal) request = request.options({ signal: requestSignal })
			if (method !== 'GET' && method !== 'HEAD')
				request = isBodyInit(body) ? request.body(body) : request.json(body ?? {})
			const response = await rawResponse(request.fetch(method))
			const envelope = (await response.json()) as IBaseAPIResponse<T>
			if (!response.ok || envelope.code !== 0) {
				if (response.status === 429)
					this.#retryGate.blockFor(parseRetryAfter(response.headers.get('retry-after')))
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

	private callEndpoint<K extends keyof KookAutoApi>(
		endpoint: K,
		...args: KookRawCallArgs<K>
	): ReturnType<KookAutoApi[K]> {
		const [payload, callOptions] = args
		const meta = endpointMap.get(String(endpoint))
		if (!meta)
			return Promise.resolve({
				ok: false,
				code: -404,
				message: `Unknown KOOK endpoint: ${String(endpoint)}`,
			}) as ReturnType<KookAutoApi[K]>
		return this.requestRaw(
			meta.method,
			meta.path,
			meta.query
				? { searchParams: payload as Record<string, unknown> }
				: isBodyInit(payload)
					? { body: payload }
					: { json: payload as JsonLike },
			callOptions,
		) as ReturnType<KookAutoApi[K]>
	}

	protected [invokeKookNative](endpoint: keyof KookAutoApi, payload?: unknown): unknown {
		return this.callEndpoint(endpoint, payload as never)
	}
}

type WretchResponseChain = { res(): Promise<Response> }

async function rawResponse(chain: WretchResponseChain): Promise<Response> {
	try {
		return await chain.res()
	} catch (error) {
		if (hasResponse(error)) return error.response
		throw error
	}
}

function hasResponse(error: unknown): error is { response: Response } {
	return (
		error !== null &&
		typeof error === 'object' &&
		'response' in error &&
		(error as { response?: unknown }).response instanceof Response
	)
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

function parseRetryAfter(value: string | null): number {
	if (!value) return 0
	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000
	const date = Date.parse(value)
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}
