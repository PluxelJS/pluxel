import { fileURLToPath } from 'node:url'
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { ui } from '@pluxel/runtime/plugin'
import { UsageBillingPlugin } from '../billing/plugin.ts'
import type { GatewayBillingContext } from '../gateway/contracts.ts'
import { createZhipuClient } from './client/client.ts'
import type { ZhipuSettingsDoc, ZhipuStatusDoc, ZhipuTestRunDoc } from './contracts.ts'
import type {
	JsonObject,
	ZhipuChatCompletionsInput,
	ZhipuEmbeddingInput,
	ZhipuGatewayCallOptions,
	ZhipuLayoutParsingInput,
	ZhipuModerationInput,
	ZhipuRawCallInput,
	ZhipuReaderInput,
	ZhipuRerankInput,
	ZhipuUploadInput,
	ZhipuWebSearchInput,
} from './provider.ts'

const pluginUi = ui(fileURLToPath(new URL('./ui/index.tsx', import.meta.url)))
const ROUTE_BASE = '/zhipu'
const VAULT_NAMESPACE = 'ZhipuProviderPlugin'
const LEGACY_VAULT_NAMESPACE = 'ZhipuOcrPlugin'
const KV_API_KEY = 'api.key'
const KV_BASE_URL = 'api.base_url'
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_LAYOUT_MODEL = 'glm-ocr'
const MAX_HISTORY = 100

type StoredSettings = {
	apiKey?: string
	baseUrl: string
}

type LayoutParsingInput = {
	userId?: string
	model: 'glm-ocr'
	file: string
	return_crop_images?: boolean
	need_layout_visualization?: boolean
	start_page_id?: number
	end_page_id?: number
	request_id?: string
	user_id?: string
	[key: string]: unknown
}

type UpstreamOutcome = {
	response: Response
	ok: boolean
	status: string
	error?: string
	outputBytes: number
	bodyText?: string
	upstreamRequestId?: string
	units?: number
	unitName?: string
}

@Plugin({ name: 'ZhipuProviderPlugin' })
export class ZhipuProviderPlugin extends BasePlugin {
	private settings = this.ctx.ext.signaldb.collection<ZhipuSettingsDoc>({ name: 'settings' })
	private status = this.ctx.ext.signaldb.collection<ZhipuStatusDoc>({ name: 'status' })
	private history = this.ctx.ext.signaldb.collection<ZhipuTestRunDoc>({ name: 'history' })
	private historySeq = 1

	constructor(private readonly billing: UsageBillingPlugin) {
		super()
	}

	override async init(): Promise<void> {
		await Promise.all([this.settings.ready(), this.status.ready(), this.history.ready()])
		this.restoreHistorySeq()
		await this.syncSettingsDoc()
		this.ensureStatusDoc()
		pluginUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new ZhipuProviderRpc(this))
		this.registerRoutes()
		this.ctx.logger.info('Zhipu provider adapter ready', {
			dependsOn: this.billing.ctx.pluginInfo.id,
			routeBase: this.ctx.http.plugin.base(ROUTE_BASE),
		})
	}

	async saveSettings(input: { apiKey?: string; baseUrl?: string }): Promise<ZhipuSettingsDoc> {
		const kv = this.kv()
		if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
			await kv.set(KV_API_KEY, input.apiKey.trim())
		}
		await kv.set(KV_BASE_URL, normalizeBaseUrl(input.baseUrl))
		await this.ctx.vault.flush()
		return this.syncSettingsDoc()
	}

	async clearApiKey(): Promise<ZhipuSettingsDoc> {
		await this.kv().delete(KV_API_KEY)
		await this.ctx.vault.flush()
		return this.syncSettingsDoc()
	}

	async testConnection(userId = 'system'): Promise<{ ok: boolean; message: string }> {
		const startedAt = Date.now()
		let status = 'error'
		let ok = false
		let error: string | undefined
		try {
			const response = await (await this.client()).raw({ method: 'GET', path: '/models' })
			status = String(response.status)
			ok = response.ok
			if (!response.ok) error = await responseText(response)
			return {
				ok,
				message: ok ? 'Zhipu API Key 可用。' : error || `测试失败：${response.status}`,
			}
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught)
			return { ok: false, message: error }
		} finally {
			const latencyMs = Date.now() - startedAt
			this.updateStatus(ok, status, error)
			this.billing.recordUsage({
				userId,
				provider: 'zhipu',
				pluginId: this.ctx.pluginInfo.id,
				operation: 'api.test',
				ok,
				status,
				latencyMs,
				units: 1,
				unitName: 'request',
				inputBytes: 0,
				outputBytes: 0,
			})
			this.recordHistory({
				source: 'settings',
				userId,
				operation: 'api.test',
				ok,
				status,
				latencyMs,
				inputBytes: 0,
				outputBytes: 0,
				error,
			})
		}
	}

	routeBase(): string {
		return this.ctx.http.plugin.base(ROUTE_BASE)
	}

	clearHistory(): { ok: true } {
		this.history.removeMany({})
		this.historySeq = 1
		return { ok: true }
	}

	listHistory(limit = 30): ZhipuTestRunDoc[] {
		const capped = Math.max(0, Math.min(MAX_HISTORY, Math.floor(limit)))
		return this.history.find({}, { limit: capped, sort: { at: -1 } })
	}

	async gatewayLayoutParsing(
		billing: GatewayBillingContext,
		input: ZhipuLayoutParsingInput,
	): Promise<unknown> {
		const payload = this.toLayoutParsingPayload(input)
		return this.gatewayCall({
			billing,
			operation: 'ocr.layout_parsing',
			model: DEFAULT_LAYOUT_MODEL,
			inputBytes: jsonBytes(payload),
			body: payload,
			path: '/layout_parsing',
			method: 'POST',
		})
	}

	async gatewayChatCompletions(
		billing: GatewayBillingContext,
		input: ZhipuChatCompletionsInput,
	): Promise<unknown> {
		return this.gatewayJsonOperation(billing, {
			operation: 'chat.completions',
			path: '/chat/completions',
			input,
			model: input.model,
		})
	}

	async gatewayFilesOcr(billing: GatewayBillingContext, input: ZhipuUploadInput): Promise<unknown> {
		const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
		const fileBytes = bytes.slice().buffer
		const blob = new Blob([fileBytes], { type: input.contentType ?? 'application/octet-stream' })
		const form = new FormData()
		form.append('file', blob, input.fileName)
		for (const [key, value] of Object.entries(input.fields)) {
			form.append(key, String(value))
		}
		return this.gatewayCall({
			billing,
			operation: 'ocr.files',
			inputBytes: bytes.byteLength,
			body: form,
			path: '/files/ocr',
			method: 'POST',
		})
	}

	async gatewayEmbeddings(
		billing: GatewayBillingContext,
		input: ZhipuEmbeddingInput,
	): Promise<unknown> {
		return this.gatewayJsonOperation(billing, {
			operation: 'embeddings.create',
			path: '/embeddings',
			input,
			model: input.model,
		})
	}

	async gatewayRerank(billing: GatewayBillingContext, input: ZhipuRerankInput): Promise<unknown> {
		return this.gatewayJsonOperation(billing, {
			operation: 'rerank.create',
			path: '/rerank',
			input,
			model: input.model,
		})
	}

	async gatewayReader(billing: GatewayBillingContext, input: ZhipuReaderInput): Promise<unknown> {
		return this.gatewayJsonOperation(billing, {
			operation: 'reader',
			path: '/reader',
			input,
		})
	}

	async gatewayModerations(
		billing: GatewayBillingContext,
		input: ZhipuModerationInput,
	): Promise<unknown> {
		return this.gatewayJsonOperation(billing, {
			operation: 'moderations.create',
			path: '/moderations',
			input,
			model: input.model,
		})
	}

	async gatewayRaw(billing: GatewayBillingContext, input: ZhipuRawCallInput): Promise<unknown> {
		const method = (input.method ?? 'POST').toUpperCase()
		const body = typeof input.body === 'string' ? input.body : (input.body ?? undefined)
		return this.gatewayCall({
			billing,
			operation: input.operation ?? `raw.${method}.${input.path.replace(/^\/+/, '')}`,
			model: input.model,
			inputBytes: body === undefined ? 0 : byteLength(body),
			body,
			path: input.path,
			method,
		})
	}

	async gatewayWebSearch(
		billing: GatewayBillingContext,
		input: ZhipuWebSearchInput,
	): Promise<unknown> {
		return this.gatewayCall({
			billing,
			operation: 'web_search',
			inputBytes: jsonBytes(input),
			body: input,
			path: '/web_search',
			method: 'POST',
		})
	}

	private gatewayJsonOperation(
		billing: GatewayBillingContext,
		options: { operation: string; path: string; input: JsonObject; model?: string },
	): Promise<unknown> {
		return this.gatewayCall({
			billing,
			operation: options.operation,
			model: options.model,
			inputBytes: jsonBytes(options.input),
			body: options.input,
			path: options.path,
			method: 'POST',
		})
	}

	private registerRoutes(): void {
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/status', async () => ({
						ok: true,
						settings: await this.syncSettingsDoc(),
						status: this.status.findOne({ id: 'status' }),
					}))
					.get('/history', () => ({
						ok: true,
						history: this.listHistory(),
					}))
					.post('/files-ocr', async ({ request }) => this.handleFilesOcr(request))
					.post('/layout-parsing', async ({ request }) => this.handleLayoutParsing(request)),
			{
				path: ROUTE_BASE,
				id: 'ZhipuProviderPlugin:http',
			},
		)
	}

	private async handleFilesOcr(request: Request): Promise<Response> {
		const startedAt = Date.now()
		let userId = userIdFromRequest(request)
		let inputBytes = 0
		let outcome: UpstreamOutcome | undefined
		let fileName: string | undefined
		try {
			const form = await request.formData()
			const upstream = new FormData()
			for (const [key, value] of form.entries()) {
				if (key === 'userId') {
					userId = normalizeUserId(String(value)) || userId
					continue
				}
				upstream.append(key, value)
				inputBytes += formEntryBytes(value)
				if (key === 'file') fileName = fileNameFromFormValue(value)
			}
			outcome = await this.forward('/files/ocr', upstream)
			return outcome.response
		} catch (caught) {
			const message = errorMessage(caught)
			outcome = jsonOutcome({ ok: false, error: message }, 500, message)
			return outcome.response
		} finally {
			this.recordUsage({
				userId,
				operation: 'ocr.files',
				model: undefined,
				startedAt,
				inputBytes,
				outcome,
			})
			this.recordHistory({
				source: 'ui',
				userId,
				operation: 'ocr.files',
				startedAt,
				inputBytes,
				outcome,
				fileName,
				requestPreview: fileName ? `file=${fileName}` : 'multipart/form-data',
			})
		}
	}

	private async handleLayoutParsing(request: Request): Promise<Response> {
		const startedAt = Date.now()
		let userId = userIdFromRequest(request)
		let inputBytes = 0
		let outcome: UpstreamOutcome | undefined
		let requestPreview: string | undefined
		try {
			const input = (await request.json()) as LayoutParsingInput
			userId = normalizeUserId(input.userId) || userId
			const payload = this.toLayoutParsingPayload(input)
			inputBytes = jsonBytes(payload)
			requestPreview = previewJson(payload)
			outcome = await this.forward('/layout_parsing', payload)
			return outcome.response
		} catch (caught) {
			const message = errorMessage(caught)
			outcome = jsonOutcome({ ok: false, error: message }, 500, message)
			return outcome.response
		} finally {
			this.recordUsage({
				userId,
				operation: 'ocr.layout_parsing',
				model: DEFAULT_LAYOUT_MODEL,
				startedAt,
				inputBytes,
				outcome,
			})
			this.recordHistory({
				source: 'ui',
				userId,
				operation: 'ocr.layout_parsing',
				model: DEFAULT_LAYOUT_MODEL,
				startedAt,
				inputBytes,
				outcome,
				requestPreview,
			})
		}
	}

	private async forward(
		path: string,
		body: BodyInit | Record<string, unknown>,
	): Promise<UpstreamOutcome> {
		const response = await (await this.client()).raw({ method: 'POST', path, body })
		return this.toOutcome(response)
	}

	private async gatewayCall(options: ZhipuGatewayCallOptions): Promise<unknown> {
		const startedAt = Date.now()
		let outcome: UpstreamOutcome | undefined
		try {
			const response = await (
				await this.client()
			).raw({
				method: options.method ?? 'POST',
				path: options.path,
				body: options.body,
			})
			outcome = await this.toOutcome(response)
			if (!outcome.ok) {
				throw new Error(outcome.error || `Zhipu request failed: ${outcome.status}`)
			}
			return await responsePayload(outcome.response)
		} catch (caught) {
			if (!outcome) {
				const message = errorMessage(caught)
				outcome = jsonOutcome({ ok: false, error: message }, 500, message)
			}
			throw caught
		} finally {
			this.recordUsage({
				userId: options.billing.userId,
				operation: options.operation,
				model: options.model,
				startedAt,
				inputBytes: options.inputBytes,
				outcome,
				metadata: {
					...(options.billing.tenantId ? { tenantId: options.billing.tenantId } : {}),
					...(options.billing.traceId ? { traceId: options.billing.traceId } : {}),
					...(options.billing.metadata ?? {}),
				},
			})
			this.recordHistory({
				source: 'rpc',
				userId: options.billing.userId,
				operation: options.operation,
				model: options.model,
				startedAt,
				inputBytes: options.inputBytes,
				outcome,
				requestPreview: requestPreview(options.body),
			})
		}
	}

	private async toOutcome(response: Response): Promise<UpstreamOutcome> {
		const text = await response.text()
		const outputBytes = new TextEncoder().encode(text).length
		const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8'
		const headers = new Headers({ 'content-type': contentType })
		const upstreamRequestId =
			response.headers.get('x-request-id') ??
			response.headers.get('x-zhipu-request-id') ??
			undefined
		if (upstreamRequestId) headers.set('x-upstream-request-id', upstreamRequestId)
		const error = response.ok ? undefined : text || `Zhipu request failed: ${response.status}`
		const usage = extractUsageUnits(text, contentType)
		return {
			response: new Response(text, { status: response.status, headers }),
			ok: response.ok,
			status: String(response.status),
			error,
			outputBytes,
			bodyText: text,
			upstreamRequestId,
			...usage,
		}
	}

	private recordUsage(input: {
		userId: string
		operation: string
		model?: string
		startedAt: number
		inputBytes: number
		outcome?: UpstreamOutcome
		metadata?: Record<string, unknown>
	}): void {
		const outcome = input.outcome ?? jsonOutcome({ ok: false, error: 'unknown outcome' }, 500)
		const latencyMs = Date.now() - input.startedAt
		this.updateStatus(outcome.ok, outcome.status, outcome.error)
		this.billing.recordUsage({
			userId: input.userId,
			provider: 'zhipu',
			pluginId: this.ctx.pluginInfo.id,
			operation: input.operation,
			model: input.model,
			ok: outcome.ok,
			status: outcome.status,
			latencyMs,
			inputBytes: input.inputBytes,
			outputBytes: outcome.outputBytes,
			units: outcome.units ?? 1,
			unitName: outcome.unitName ?? 'request',
			upstreamRequestId: outcome.upstreamRequestId,
			metadata: {
				...(input.metadata ?? {}),
				...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
			},
		})
	}

	private recordHistory(input: {
		source: ZhipuTestRunDoc['source']
		userId: string
		operation: string
		model?: string
		startedAt?: number
		latencyMs?: number
		inputBytes: number
		outputBytes?: number
		ok?: boolean
		status?: string
		error?: string
		outcome?: UpstreamOutcome
		fileName?: string
		requestPreview?: string
	}): void {
		const outcome = input.outcome
		const doc: ZhipuTestRunDoc = {
			id: String(this.historySeq++),
			at: Date.now(),
			source: input.source,
			userId: input.userId,
			operation: input.operation,
			...(input.model ? { model: input.model } : {}),
			ok: input.ok ?? outcome?.ok ?? false,
			status: input.status ?? outcome?.status ?? 'error',
			latencyMs: input.latencyMs ?? (input.startedAt ? Date.now() - input.startedAt : 0),
			inputBytes: Math.max(0, Math.floor(input.inputBytes)),
			outputBytes: Math.max(0, Math.floor(input.outputBytes ?? outcome?.outputBytes ?? 0)),
			...(input.fileName ? { fileName: input.fileName } : {}),
			...(outcome?.upstreamRequestId ? { upstreamRequestId: outcome.upstreamRequestId } : {}),
			...(input.requestPreview ? { requestPreview: truncate(input.requestPreview, 2_000) } : {}),
			...(outcome?.bodyText ? { responsePreview: truncate(outcome.bodyText, 8_000) } : {}),
			...(input.error ?? outcome?.error
				? { error: truncate(input.error ?? outcome?.error ?? '', 2_000) }
				: {}),
		}
		this.history.insert(doc)
		this.trimHistory()
	}

	private toLayoutParsingPayload(
		input: LayoutParsingInput | ZhipuLayoutParsingInput,
	): Record<string, unknown> {
		const payload: Record<string, unknown> = {
			...input,
			model: DEFAULT_LAYOUT_MODEL,
		}
		delete payload.userId
		if (typeof payload.file !== 'string' || !payload.file.trim()) {
			throw new Error('layout_parsing requires OpenAPI field `file`')
		}
		return payload
	}

	private async client() {
		const settings = await this.readStoredSettings()
		if (!settings.apiKey) throw new Error('请先保存 Zhipu API Key')
		return createZhipuClient({
			apiKey: settings.apiKey,
			baseUrl: settings.baseUrl,
		})
	}

	private async readStoredSettings(): Promise<StoredSettings> {
		const kv = this.kv()
		const legacyKv = this.legacyKv()
		const baseUrl =
			(await kv.get<string>(KV_BASE_URL)) ??
			(await legacyKv.get<string>(KV_BASE_URL)) ??
			DEFAULT_BASE_URL
		const apiKey = (await kv.get<string>(KV_API_KEY)) ?? (await legacyKv.get<string>(KV_API_KEY))
		return { apiKey, baseUrl }
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private legacyKv() {
		return this.ctx.vault.namespace(LEGACY_VAULT_NAMESPACE).kv()
	}

	private async syncSettingsDoc(): Promise<ZhipuSettingsDoc> {
		const stored = await this.readStoredSettings()
		const doc: ZhipuSettingsDoc = {
			id: 'settings',
			hasApiKey: Boolean(stored.apiKey),
			apiKeyPreview: maskApiKey(stored.apiKey),
			baseUrl: stored.baseUrl,
			updatedAt: Date.now(),
		}
		this.settings.replaceOne({ id: 'settings' }, doc, { upsert: true })
		return doc
	}

	private ensureStatusDoc(): void {
		if (this.status.findOne({ id: 'status' })) return
		this.status.insert({
			id: 'status',
			lastOk: null,
			lastStatus: null,
			lastError: null,
			updatedAt: null,
		})
	}

	private restoreHistorySeq(): void {
		const maxId = this.history
			.find({}, { limit: MAX_HISTORY })
			.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0)
		this.historySeq = maxId + 1
	}

	private trimHistory(): void {
		const all = this.history.find({}, { sort: { at: 1 } })
		const overflow = all.length - MAX_HISTORY
		if (overflow <= 0) return
		for (const record of all.slice(0, overflow)) this.history.removeOne({ id: record.id })
	}

	private updateStatus(ok: boolean, status: string, error?: string): void {
		this.status.replaceOne(
			{ id: 'status' },
			{
				id: 'status',
				lastOk: ok,
				lastStatus: status,
				lastError: error ?? null,
				updatedAt: Date.now(),
			},
			{ upsert: true },
		)
	}
}

setParamToken(ZhipuProviderPlugin, 0, UsageBillingPlugin)

export class ZhipuProviderRpc extends RpcTarget {
	constructor(private readonly plugin: ZhipuProviderPlugin) {
		super()
	}

	saveSettings(input: { apiKey?: string; baseUrl?: string }) {
		return this.plugin.saveSettings(input)
	}

	clearApiKey() {
		return this.plugin.clearApiKey()
	}

	testConnection(userId?: string) {
		return this.plugin.testConnection(normalizeUserId(userId) || 'system')
	}

	clearHistory() {
		return this.plugin.clearHistory()
	}

	listHistory(limit?: number) {
		return this.plugin.listHistory(limit)
	}

	routeBase() {
		return this.plugin.routeBase()
	}
}

function normalizeBaseUrl(input: string | undefined): string {
	const raw = input?.trim() || DEFAULT_BASE_URL
	return raw.replace(/\/+$/, '')
}

function normalizeUserId(input: unknown): string | undefined {
	const value = typeof input === 'string' ? input.trim() : ''
	return value || undefined
}

function userIdFromRequest(request: Request): string {
	const url = new URL(request.url)
	return (
		normalizeUserId(request.headers.get('x-pluxel-user-id')) ??
		normalizeUserId(request.headers.get('x-user-id')) ??
		normalizeUserId(url.searchParams.get('userId')) ??
		'anonymous'
	)
}

function formEntryBytes(value: FormDataEntryValue): number {
	if (typeof value === 'string') return value.length
	const size = (value as { size?: unknown }).size
	return typeof size === 'number' ? size : 0
}

function fileNameFromFormValue(value: FormDataEntryValue): string | undefined {
	if (typeof value === 'string') return undefined
	const name = (value as { name?: unknown }).name
	return typeof name === 'string' && name.trim() ? name : undefined
}

function jsonBytes(input: unknown): number {
	return new TextEncoder().encode(JSON.stringify(input)).length
}

function byteLength(input: unknown): number {
	if (typeof input === 'string') return new TextEncoder().encode(input).length
	if (input instanceof ArrayBuffer) return input.byteLength
	if (input instanceof Uint8Array) return input.byteLength
	return jsonBytes(input)
}

function previewJson(input: unknown): string {
	try {
		return JSON.stringify(input, null, 2)
	} catch {
		return String(input)
	}
}

function requestPreview(input: unknown): string | undefined {
	if (input === undefined || input === null) return undefined
	if (typeof input === 'string') return input
	if (typeof FormData !== 'undefined' && input instanceof FormData) return 'multipart/form-data'
	if (typeof URLSearchParams !== 'undefined' && input instanceof URLSearchParams) {
		return input.toString()
	}
	if (typeof Blob !== 'undefined' && input instanceof Blob) return `blob:${input.size}`
	if (input instanceof ArrayBuffer || input instanceof Uint8Array) return `binary:${byteLength(input)}`
	return previewJson(input)
}

function truncate(input: string, maxLength: number): string {
	return input.length > maxLength ? `${input.slice(0, maxLength)}...` : input
}

function maskApiKey(apiKey: string | undefined): string | null {
	if (!apiKey) return null
	if (apiKey.length <= 10) return `${apiKey.slice(0, 2)}***${apiKey.slice(-2)}`
	return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function extractUsageUnits(
	text: string,
	contentType: string,
): Pick<UpstreamOutcome, 'units' | 'unitName'> {
	if (!contentType.includes('application/json') || !text.trim()) return {}
	try {
		const payload = JSON.parse(text) as { usage?: Record<string, unknown> }
		const totalTokens = payload.usage?.total_tokens ?? payload.usage?.totalTokens
		if (typeof totalTokens === 'number' && Number.isFinite(totalTokens)) {
			return { units: Math.max(0, totalTokens), unitName: 'token' }
		}
	} catch {
		return {}
	}
	return {}
}

function jsonOutcome(payload: unknown, status: number, error?: string): UpstreamOutcome {
	const body = JSON.stringify(payload)
	return {
		response: new Response(body, {
			status,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		}),
		ok: status >= 200 && status < 300,
			status: String(status),
			error,
			outputBytes: new TextEncoder().encode(body).length,
			bodyText: body,
		}
	}

async function responseText(response: Response): Promise<string> {
	try {
		return await response.text()
	} catch {
		return ''
	}
}

async function responsePayload(response: Response): Promise<unknown> {
	const contentType = response.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) return await response.json()
	return await response.text()
}
