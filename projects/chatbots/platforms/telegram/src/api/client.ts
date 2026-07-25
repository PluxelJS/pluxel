import type { APIMethodParams, APIMethodReturn, APIMethods } from '@gramio/types'
import type { Wretch } from '@pluxel/wretch'
import { RetryGate } from '@repo/chatbots-platform-kit/retry-gate'
import { TELEGRAM_ENDPOINTS, type TelegramHttpMethod, type TelegramMethod } from './endpoints.ts'
import { invokeTelegramNative, TelegramNativeApi } from './native.ts'

export type TelegramClientOptions = {
	http: Wretch
	token: string
	apiBase?: string
	signal?: AbortSignal
}

export type TelegramCallOptions = { signal?: AbortSignal }
export type TelegramRawApi = {
	call<M extends TelegramMethod>(
		endpoint: M,
		...args: TelegramCallArgs<M>
	): Promise<APIMethodReturn<M>>
}

export class TelegramApiClient extends TelegramNativeApi {
	readonly $: Readonly<{ raw: TelegramRawApi }>
	readonly #options: TelegramClientOptions
	readonly #token: string
	readonly #apiBase: string
	readonly #http: Wretch
	readonly #methods = new Map<string, TelegramHttpMethod>(TELEGRAM_ENDPOINTS)
	readonly #retryGate = new RetryGate()

	constructor(options: TelegramClientOptions) {
		super()
		this.#options = options
		this.#token = options.token.trim()
		if (!this.#token) throw new Error('Telegram client requires a Bot token')
		this.#apiBase = (options.apiBase?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')
		this.#http = options.http
		this.$ = Object.freeze({
			raw: Object.freeze({
				call: <M extends TelegramMethod>(endpoint: M, ...args: TelegramCallArgs<M>) =>
					this.requestEndpoint(endpoint, ...args),
			}),
		})
	}

	private async requestEndpoint<M extends TelegramMethod>(
		endpoint: M,
		...args: TelegramCallArgs<M>
	): Promise<APIMethodReturn<M>> {
		const [payload = {}, callOptions] = args
		const method = this.#methods.get(endpoint)
		if (!method) throw new Error(`Unknown Telegram endpoint: ${endpoint}`)
		const requestSignal = combineSignals(this.#options.signal, callOptions?.signal)
		await this.#retryGate.wait(requestSignal)
		const url = new URL(`${this.#apiBase}/bot${this.#token}/${endpoint}`)
		if (method === 'GET' && isRecord(payload)) appendQuery(url, payload)
		const body = method === 'POST' ? telegramRequestBody(payload) : undefined
		let request = this.#http.url(url.toString(), true)
		if (requestSignal) request = request.options({ signal: requestSignal })
		const response = await rawResponse(
			method === 'GET'
				? request.get()
				: body instanceof FormData
					? request.post(body)
					: request.content('application/json').post(body),
		)
		const envelope = (await response.json()) as TelegramResponse<APIMethodReturn<M>>
		if (!response.ok || !envelope.ok || envelope.result === undefined) {
			this.#retryGate.blockFor(retryAfterMs(envelope.parameters?.retry_after))
			throw new Error(
				`Telegram ${endpoint} failed (${response.status}): ${envelope.description ?? 'unknown error'}`,
			)
		}
		return envelope.result
	}

	protected [invokeTelegramNative](endpoint: TelegramMethod, payload?: unknown): unknown {
		return this.requestEndpoint(endpoint, payload as never)
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
		Boolean(error) &&
		typeof error === 'object' &&
		'response' in error &&
		(error as { response?: unknown }).response instanceof Response
	)
}

export type TelegramCallArgs<M extends TelegramMethod> =
	undefined extends APIMethodParams<M>
		? [payload?: APIMethodParams<M>, options?: TelegramCallOptions]
		: [payload: APIMethodParams<M>, options?: TelegramCallOptions]
export type TelegramApi = TelegramApiClient & APIMethods

type TelegramResponse<T> = {
	ok: boolean
	result?: T
	description?: string
	parameters?: { retry_after?: number }
}

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

function retryAfterMs(seconds: number | undefined): number {
	return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
		? seconds * 1_000
		: 0
}
