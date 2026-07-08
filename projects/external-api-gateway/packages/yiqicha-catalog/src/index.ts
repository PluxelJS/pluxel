import { createHash } from 'node:crypto'

import catalogJson from '../data/apis.json' with { type: 'json' }
import { yiqichaApiCodes, type YiqichaApiKey } from './api-codes.ts'
import { type YiqichaApiParamsByKey, type YiqichaApiResponseByKey } from './generated-types.ts'

export { yiqichaApiCodes, type YiqichaApiKey } from './api-codes.ts'
export type {
	YiqichaApiParamsByKey,
	YiqichaApiResponseByKey,
	YiqichaApiTypeMap,
} from './generated-types.ts'
export type * from './generated-types.ts'

export interface YiqichaCategory {
	id: string | null
	cateName: string
	interfaceCount: number
	cateFlag: number
}

export interface YiqichaParameter {
	name: string
	desc?: string
	required?: boolean
	type?: string
	[key: string]: unknown
}

export interface YiqichaExamples {
	java?: string
	python?: string
	php?: string
	node?: string
	cs?: string
}

export interface YiqichaApi {
	id: string
	apiName: string
	apiCode: string
	apiUrl: string
	cateId: string
	cateName: string
	dataFormat: string
	requestMethod: 'GET' | 'POST' | string
	requestDemo: string
	requestJson: string
	responseDemo: string
	responseJson: string
	interfaceDesc?: string
	interfaceIcon?: string
	unitPrice?: number
	useType?: number
	attachmentFile?: string | null
	javaDemo?: string
	pythonDemo?: string
	phpDemo?: string
	nodeDemo?: string
	csDemo?: string
	demo?: {
		javaDemo?: string
		pythonDemo?: string
		phpDemo?: string
		nodeDemo?: string
		csDemo?: string
		error?: string
	}
}

export interface YiqichaCatalog {
	source: string
	fetchedAt: string
	totalCount: number
	categories: YiqichaCategory[]
	apis: YiqichaApi[]
}

export interface YiqichaClientOptions {
	appkey: string
	secretKey: string
	baseUrl?: string | URL
	fetch?: typeof fetch
}

export type YiqichaParams = Record<
	string,
	string | number | boolean | null | undefined | readonly (string | number | boolean)[]
>

export type YiqichaNamedApiClient = {
	[Key in YiqichaApiKey]: <T = YiqichaApiResponseByKey<Key>>(
		params?: YiqichaApiParamsByKey<Key>,
		init?: RequestInit,
	) => Promise<T>
}

export class YiqichaApiError extends Error {
	readonly response: Response
	readonly body: string

	constructor(message: string, response: Response, body: string) {
		super(message)
		this.name = 'YiqichaApiError'
		this.response = response
		this.body = body
	}
}

export const yiqichaCatalog = catalogJson as YiqichaCatalog

export function createYiqichaSign(appkey: string, timestamp: string, secretKey: string): string {
	return createHash('md5').update(`${appkey}${timestamp}${secretKey}`).digest('hex')
}

export function listYiqichaApis(
	filter: {
		cateId?: string
		cateName?: string
		keyword?: string
	} = {},
): YiqichaApi[] {
	const keyword = filter.keyword?.toLowerCase()

	return yiqichaCatalog.apis.filter((api) => {
		if (filter.cateId && api.cateId !== filter.cateId) return false
		if (filter.cateName && api.cateName !== filter.cateName) return false
		if (!keyword) return true

		return (
			api.apiName.toLowerCase().includes(keyword) ||
			api.apiCode.toLowerCase().includes(keyword) ||
			api.interfaceDesc?.toLowerCase().includes(keyword) === true
		)
	})
}

export function getYiqichaApi(idOrCodeOrName: string): YiqichaApi | undefined {
	const apiCode = yiqichaApiCodes[idOrCodeOrName as YiqichaApiKey] ?? idOrCodeOrName

	return yiqichaCatalog.apis.find(
		(api) => api.id === apiCode || api.apiCode === apiCode || api.apiName === idOrCodeOrName,
	)
}

export function getYiqichaApiByKey(key: YiqichaApiKey): YiqichaApi {
	return requireYiqichaApi(yiqichaApiCodes[key])
}

export function getYiqichaApiRequiredParams(api: YiqichaApi): YiqichaParameter[] {
	return parseParameters(api.requestJson).filter((parameter) => parameter.required === true)
}

export function getApiExamples(idOrCodeOrName: string): YiqichaExamples {
	const api = requireYiqichaApi(idOrCodeOrName)
	const demo = api.demo ?? {}
	const examples: YiqichaExamples = {}
	const java = demo.javaDemo ?? api.javaDemo
	const python = demo.pythonDemo ?? api.pythonDemo
	const php = demo.phpDemo ?? api.phpDemo
	const node = demo.nodeDemo ?? api.nodeDemo
	const cs = demo.csDemo ?? api.csDemo

	if (java !== undefined) examples.java = java
	if (python !== undefined) examples.python = python
	if (php !== undefined) examples.php = php
	if (node !== undefined) examples.node = node
	if (cs !== undefined) examples.cs = cs

	return examples
}

export function parseParameters(value: string): YiqichaParameter[] {
	if (!value) return []

	const parsed: unknown = JSON.parse(value)
	if (!Array.isArray(parsed)) return []

	return parsed.filter(isParameter)
}

export class YiqichaClient {
	readonly apis: YiqichaNamedApiClient

	readonly #appkey: string
	readonly #secretKey: string
	readonly #baseUrl: URL | undefined
	readonly #fetch: typeof fetch

	constructor(options: YiqichaClientOptions) {
		this.#appkey = options.appkey
		this.#secretKey = options.secretKey
		this.#baseUrl = options.baseUrl ? new URL(options.baseUrl) : undefined
		this.#fetch = options.fetch ?? fetch
		this.apis = new Proxy({} as YiqichaNamedApiClient, {
			get: (_target, property) => {
				if (typeof property !== 'string') return undefined
				if (!(property in yiqichaApiCodes)) return undefined

				return <T = unknown>(params?: YiqichaParams, init?: RequestInit) =>
					this.call<T>(yiqichaApiCodes[property as YiqichaApiKey], params, init)
			},
		})
	}

	getApi(idOrCodeOrName: string): YiqichaApi | undefined {
		return getYiqichaApi(idOrCodeOrName)
	}

	async call<Key extends YiqichaApiKey>(
		idOrCodeOrName: Key,
		params?: YiqichaApiParamsByKey<Key>,
		init?: RequestInit,
	): Promise<YiqichaApiResponseByKey<Key>>
	async call<T = unknown>(
		idOrCodeOrName: string,
		params?: YiqichaParams,
		init?: RequestInit,
	): Promise<T>
	async call<T = unknown>(
		idOrCodeOrName: string,
		params: YiqichaParams = {},
		init: RequestInit = {},
	): Promise<T> {
		const api = requireYiqichaApi(idOrCodeOrName)
		const timestamp = String(Date.now())
		const sign = createYiqichaSign(this.#appkey, timestamp, this.#secretKey)
		const url = this.#createUrl(api, params)
		const method = api.requestMethod.toUpperCase()
		const headers = new Headers(init.headers)

		headers.set('content-type', 'application/x-www-form-urlencoded; charset=UTF-8')
		headers.set('Auth-Version', 'v1')
		headers.set('appkey', this.#appkey)
		headers.set('timestamp', timestamp)
		headers.set('sign', sign)

		const requestInit: RequestInit = {
			...init,
			method,
			headers,
		}

		if (method !== 'GET') requestInit.body = encodeParams(params)

		const response = await this.#fetch(url, requestInit)
		const body = await response.text()

		if (!response.ok) {
			throw new YiqichaApiError(
				`YiQiCha request failed with HTTP ${response.status}`,
				response,
				body,
			)
		}

		return parseResponse<T>(body)
	}

	#createUrl(api: YiqichaApi, params: YiqichaParams): URL {
		const url = new URL(api.apiUrl)

		if (this.#baseUrl) {
			url.protocol = this.#baseUrl.protocol
			url.host = this.#baseUrl.host
		}

		if (api.requestMethod.toUpperCase() === 'GET') {
			appendParams(url.searchParams, params)
		}

		return url
	}
}

function requireYiqichaApi(idOrCodeOrName: string): YiqichaApi {
	const api = getYiqichaApi(idOrCodeOrName)
	if (!api) throw new Error(`Unknown YiQiCha API: ${idOrCodeOrName}`)
	return api
}

function appendParams(searchParams: URLSearchParams, params: YiqichaParams): void {
	for (const [key, value] of Object.entries(params)) {
		if (value == null) continue

		if (Array.isArray(value)) {
			for (const item of value) searchParams.append(key, String(item))
			continue
		}

		searchParams.set(key, String(value))
	}
}

function encodeParams(params: YiqichaParams): URLSearchParams {
	const searchParams = new URLSearchParams()
	appendParams(searchParams, params)
	return searchParams
}

function parseResponse<T>(body: string): T {
	if (!body) return undefined as T

	try {
		return JSON.parse(body) as T
	} catch {
		return body as T
	}
}

function isParameter(value: unknown): value is YiqichaParameter {
	return (
		typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
	)
}
