import type { APIMethodParams, APIMethodReturn, APIMethods } from '@gramio/types'
import { TELEGRAM_ENDPOINTS, type TelegramHttpMethod, type TelegramMethod } from './endpoints.ts'
import { invokeTelegramNative, TelegramNativeApi } from './native.ts'

export type TelegramClientOptions = {
	token: string
	apiBase?: string
	signal?: AbortSignal
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export class TelegramApiClient extends TelegramNativeApi {
	readonly #options: TelegramClientOptions
	readonly #token: string
	readonly #apiBase: string
	readonly #fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
	readonly #methods = new Map<string, TelegramHttpMethod>(TELEGRAM_ENDPOINTS)
	readonly #lifecycle = new AbortController()

	constructor(options: TelegramClientOptions) {
		super()
		this.#options = options
		this.#token = options.token.trim()
		if (!this.#token) throw new Error('Telegram client requires a Bot token')
		this.#apiBase = (options.apiBase?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')
		this.#fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
	}

	async call<M extends TelegramMethod>(
		endpoint: M,
		...args: TelegramCallArgs<M>
	): Promise<APIMethodReturn<M>> {
		const [payload = {}, signal] = args
		const method = this.#methods.get(endpoint)
		if (!method) throw new Error(`Unknown Telegram endpoint: ${endpoint}`)
		const requestSignal = combineSignals(this.#lifecycle.signal, this.#options.signal, signal)
		const url = new URL(`${this.#apiBase}/bot${this.#token}/${endpoint}`)
		if (method === 'GET' && isRecord(payload)) appendQuery(url, payload)
		const body = method === 'POST' ? telegramRequestBody(payload) : undefined
		const response = await this.#fetchImpl(url, {
			method,
			signal: requestSignal,
			...(method === 'POST'
				? body instanceof FormData
					? { body }
					: { headers: { 'content-type': 'application/json' }, body }
				: {}),
		})
		const envelope = (await response.json()) as TelegramResponse<APIMethodReturn<M>>
		if (!response.ok || !envelope.ok || envelope.result === undefined)
			throw new Error(
				`Telegram ${endpoint} failed (${response.status}): ${envelope.description ?? 'unknown error'}`,
			)
		return envelope.result
	}

	protected closeClient(reason?: unknown): void {
		if (!this.#lifecycle.signal.aborted) this.#lifecycle.abort(reason)
	}

	protected [invokeTelegramNative](endpoint: TelegramMethod, payload?: unknown): unknown {
		return this.call(endpoint, payload as never)
	}
}

export type TelegramCallArgs<M extends TelegramMethod> =
	undefined extends APIMethodParams<M>
		? [payload?: APIMethodParams<M>, signal?: AbortSignal]
		: [payload: APIMethodParams<M>, signal?: AbortSignal]
export type TelegramApi = TelegramApiClient & APIMethods

type TelegramResponse<T> = { ok: boolean; result?: T; description?: string }

export function createTelegramClient(options: TelegramClientOptions): TelegramApi {
	return new TelegramApiClient(options)
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))]
	if (active.length === 0) return undefined
	return active.length === 1 ? active[0] : AbortSignal.any(active)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function appendQuery(url: URL, payload: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined || value === null) continue
		if (typeof value === 'object') url.searchParams.set(key, JSON.stringify(value))
		else url.searchParams.set(key, serializeQuery(value))
	}
}

/** Converts GramIO's Blob-based TelegramInputFile values into attach:// multipart payloads. */
export function telegramRequestBody(payload: unknown): string | FormData {
	const attachments: Array<{ name: string; blob: Blob }> = []
	const visit = (value: unknown): unknown => {
		if (value instanceof Blob) {
			const name = `file_${attachments.length}`
			attachments.push({ name, blob: value })
			return `attach://${name}`
		}
		if (Array.isArray(value)) return value.map(visit)
		if (isRecord(value))
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, item]) => item !== undefined)
					.map(([key, item]) => [key, visit(item)]),
			)
		return value
	}
	const normalized = visit(payload)
	if (attachments.length === 0) return JSON.stringify(normalized) ?? 'null'
	const form = new FormData()
	for (const [key, value] of Object.entries(isRecord(normalized) ? normalized : {})) {
		if (value === undefined) continue
		form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
	}
	for (const attachment of attachments) form.set(attachment.name, attachment.blob)
	return form
}

function serializeQuery(value: unknown): string {
	return value instanceof Date ? value.toISOString() : String(value)
}
