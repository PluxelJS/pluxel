import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import '@pluxel/runtime/register/static'
import '@pluxel/runtime/services/web-management'
import '@pluxel/runtime/services/vault'
import {
	createYiqichaSign,
	getYiqichaApi,
	getYiqichaApiRequiredParams,
	yiqichaApiCodes,
	yiqichaCatalog,
	type YiqichaApi,
} from '@repo/external-api-gateway-yiqicha-catalog'
import {
	DEFAULT_YIQICHA_BASE_URL,
	MAX_YIQICHA_HISTORY,
	UsageRecorderPlugin,
	type ExternalGatewayDbHandle,
	useExternalGatewayDB,
	yiqichaResponseCache,
	yiqichaTestRuns,
	type YiqichaResponseCacheRow,
	type YiqichaTestRunRow,
} from '@repo/external-api-gateway-shared'
import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { ui } from '@pluxel/runtime/plugin'
import { desc, eq } from 'drizzle-orm'
import type { YiqichaSettingsDoc, YiqichaStatusDoc, YiqichaTestRunDoc } from './contracts.ts'
import type {
	YiqichaApiDoc,
	YiqichaApiSummary,
	YiqichaCatalogFilter,
	YiqichaGatewayCallOptions,
	YiqichaParams,
	YiqichaRawCallInput,
} from './provider.ts'
import { parseUpstreamError, previewJson, requestPreview } from './preview.ts'

const pluginUi = ui(fileURLToPath(new URL('./ui/index.tsx', import.meta.url)))
const ROUTE_BASE = '/yiqicha'
const VAULT_NAMESPACE = 'YiqichaProviderPlugin'
const KV_APPKEY = 'api.appkey'
const KV_SECRET_KEY = 'api.secret_key'
const KV_BASE_URL = 'api.base_url'
const DEFAULT_TEST_API = '1000'
const DEFAULT_TEST_KEYWORD = '亿企查科技有限公司'
const MAX_YIQICHA_RESPONSE_CACHE_ROWS = 50_000
const apiKeyByCode: Map<string, string> = new Map(
	Object.entries(yiqichaApiCodes).map(([key, code]) => [code, key]),
)

type StoredSettings = {
	appkey?: string
	secretKey?: string
	baseUrl: string
}

type ReadySettings = StoredSettings & {
	appkey: string
	secretKey: string
}

type UpstreamOutcome = {
	response: Response
	ok: boolean
	status: string
	error?: string
	errorCode?: string
	outputBytes: number
	bodyText?: string
	upstreamRequestId?: string
	units?: number
	unitName?: string
	cacheHit?: boolean
	cacheCoalesced?: boolean
	cacheKey?: string
	cacheAgeMs?: number
	cacheStoredAt?: number
}

type CacheKey = {
	id: string
	paramsJson: string
}

type ForwardApiOptions = {
	noCache?: boolean
}

@Plugin({ name: 'YiqichaProviderPlugin' })
export class YiqichaProviderPlugin extends BasePlugin {
	private settings = this.ctx.ext.signaldb.collection<YiqichaSettingsDoc>({ name: 'settings' })
	private status = this.ctx.ext.signaldb.collection<YiqichaStatusDoc>({ name: 'status' })
	private history = this.ctx.ext.signaldb.collection<YiqichaTestRunDoc>({ name: 'history' })
	private data: ExternalGatewayDbHandle | undefined
	private historySeq = 1
	private readonly inflight = new Map<string, Promise<UpstreamOutcome>>()

	constructor(private readonly usageRecorder: UsageRecorderPlugin) {
		super()
	}

	override async init(): Promise<void> {
		await Promise.all([this.settings.ready(), this.status.ready(), this.history.ready()])
		this.data = await useExternalGatewayDB(this.ctx)
		await this.loadHistoryFromDB()
		await this.syncSettingsDoc()
		this.ensureStatusDoc()
		pluginUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new YiqichaProviderRpc(this))
		this.registerRoutes()
		this.ctx.logger.info('YiQiCha provider adapter ready', {
			dependsOn: this.usageRecorder.ctx.pluginInfo.id,
			routeBase: this.ctx.http.plugin.base(ROUTE_BASE),
			apiCount: yiqichaCatalog.apis.length,
		})
	}

	async saveSettings(input: {
		appkey?: string
		secretKey?: string
		baseUrl?: string
	}): Promise<YiqichaSettingsDoc> {
		const kv = this.kv()
		if (typeof input.appkey === 'string' && input.appkey.trim()) {
			await kv.set(KV_APPKEY, input.appkey.trim())
		}
		if (typeof input.secretKey === 'string' && input.secretKey.trim()) {
			await kv.set(KV_SECRET_KEY, input.secretKey.trim())
		}
		await kv.set(KV_BASE_URL, normalizeBaseUrl(input.baseUrl))
		await this.ctx.vault.flush()
		return this.syncSettingsDoc()
	}

	async clearSecrets(): Promise<YiqichaSettingsDoc> {
		const kv = this.kv()
		await Promise.all([kv.delete(KV_APPKEY), kv.delete(KV_SECRET_KEY)])
		await this.ctx.vault.flush()
		return this.syncSettingsDoc()
	}

	async testConnection(
		input: {
			userId?: string
			api?: string
			keyword?: string
		} = {},
	): Promise<{ ok: boolean; message: string }> {
		const userId = normalizeUserId(input.userId) || 'system'
		const api = input.api?.trim() || DEFAULT_TEST_API
		const startedAt = Date.now()
		const params = {
			keyword: input.keyword?.trim() || DEFAULT_TEST_KEYWORD,
			pageSize: 1,
		}
		let outcome: UpstreamOutcome | undefined
		let apiInfo: YiqichaApi | undefined
		try {
			apiInfo = requireYiqichaApi(api)
			outcome = await this.forwardApi(apiInfo, params, { noCache: true })
			return {
				ok: outcome.ok,
				message: outcome.ok
					? `YiQiCha ${apiInfo.apiName} 测试成功。`
					: outcome.error || `测试失败：${outcome.status}`,
			}
		} catch (caught) {
			const message = errorMessage(caught)
			outcome = jsonOutcome({ ok: false, error: message }, 500, message)
			return { ok: false, message }
		} finally {
			this.recordUsage({
				userId,
				operation: operationId(apiInfo ?? api),
				api: apiInfo,
				startedAt,
				inputBytes: jsonBytes(params),
				outcome,
			})
			this.recordHistory({
				source: 'settings',
				userId,
				operation: operationId(apiInfo ?? api),
				api: apiInfo,
				startedAt,
				inputBytes: jsonBytes(params),
				outcome,
				requestPreview: previewJson(params),
			})
		}
	}

	routeBase(): string {
		return this.ctx.http.plugin.base(ROUTE_BASE)
	}

	listCatalog(filter: YiqichaCatalogFilter = {}): YiqichaApiSummary[] {
		const keyword = filter.keyword?.trim().toLowerCase()
		const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 100)))
		return yiqichaCatalog.apis
			.filter((api) => {
				if (!keyword) return true
				return (
					api.apiName.toLowerCase().includes(keyword) ||
					api.apiCode.toLowerCase().includes(keyword) ||
					api.cateName.toLowerCase().includes(keyword) ||
					api.interfaceDesc?.toLowerCase().includes(keyword) === true
				)
			})
			.slice(0, limit)
			.map(compactApiDoc)
	}

	getApiDoc(idOrCodeOrName: string): YiqichaApiDoc {
		const api = requireYiqichaApi(idOrCodeOrName)
		return {
			...compactApiDoc(api),
			requiredParams: getYiqichaApiRequiredParams(api),
			requestJson: api.requestJson,
			responseJson: api.responseJson,
			responseDemo: api.responseDemo,
			interfaceDesc: api.interfaceDesc,
			unitPrice: api.unitPrice,
		}
	}

	clearHistory(): { ok: true } {
		this.history.removeMany({})
		this.historySeq = 1
		void this.data?.db.delete(yiqichaTestRuns).catch((error) => {
			this.ctx.logger.warn('Failed to clear YiQiCha test history database', { error })
		})
		return { ok: true }
	}

	listHistory(limit = 30): YiqichaTestRunDoc[] {
		const capped = Math.max(0, Math.min(MAX_YIQICHA_HISTORY, Math.floor(limit)))
		return this.history.find({}, { limit: capped, sort: { at: -1 } })
	}

	async gatewayRaw(billing: GatewayBillingContext, input: YiqichaRawCallInput): Promise<unknown> {
		return this.gatewayCall({
			billing,
			operation: input.operation ?? operationId(input.api),
			api: input.api,
			params: input.params,
			noCache: input.noCache,
		})
	}

	async gatewayCallApi(
		billing: GatewayBillingContext,
		api: string,
		params?: YiqichaParams,
		options: ForwardApiOptions = {},
	): Promise<unknown> {
		return this.gatewayCall({
			billing,
			operation: operationId(api),
			api,
			params,
			noCache: options.noCache,
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
						apiCount: yiqichaCatalog.apis.length,
					}))
					.get('/history', () => ({
						ok: true,
						history: this.listHistory(),
					}))
					.post('/call', async ({ request }) => this.handleUiCall(request)),
			{
				path: ROUTE_BASE,
				id: 'YiqichaProviderPlugin:http',
			},
		)
	}

	private async handleUiCall(request: Request): Promise<Response> {
		const startedAt = Date.now()
		let userId = userIdFromRequest(request)
		let inputBytes = 0
		let outcome: UpstreamOutcome | undefined
		let requestPreviewText: string | undefined
		let api: YiqichaApi | undefined
		try {
			const input = (await request.json()) as Record<string, unknown>
			userId = normalizeUserId(input.userId) || userId
			api = requireYiqichaApi(stringField(input, 'api') ?? stringField(input, 'apiCode') ?? '')
			const params = normalizeParams(input.params)
			const noCache = booleanField(input, 'noCache') ?? false
			inputBytes = jsonBytes(params)
			requestPreviewText = previewJson(params)
			outcome = await this.forwardApi(api, params, { noCache })
			return outcome.response
		} catch (caught) {
			const message = errorMessage(caught)
			outcome = jsonOutcome({ ok: false, error: message }, 500, message)
			return outcome.response
		} finally {
			this.recordUsage({
				userId,
				operation: operationId(api),
				api,
				startedAt,
				inputBytes,
				outcome,
			})
			this.recordHistory({
				source: 'ui',
				userId,
				operation: operationId(api),
				api,
				startedAt,
				inputBytes,
				outcome,
				requestPreview: requestPreviewText,
			})
		}
	}

	private async gatewayCall(options: YiqichaGatewayCallOptions): Promise<unknown> {
		const startedAt = Date.now()
		let outcome: UpstreamOutcome | undefined
		let api: YiqichaApi | undefined
		try {
			api = requireYiqichaApi(options.api)
			outcome = await this.forwardApi(api, options.params ?? {}, { noCache: options.noCache })
			if (!outcome.ok) {
				throw new Error(outcome.error || `YiQiCha request failed: ${outcome.status}`)
			}
			return await responsePayload(outcome.response, outcome)
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
				api,
				startedAt,
				inputBytes: jsonBytes(options.params ?? {}),
				outcome,
				metadata: {
					...(options.billing.tenantId ? { tenantId: options.billing.tenantId } : {}),
					...(options.billing.traceId ? { traceId: options.billing.traceId } : {}),
					...options.billing.metadata,
				},
			})
			this.recordHistory({
				source: 'rpc',
				userId: options.billing.userId,
				operation: options.operation,
				api,
				startedAt,
				inputBytes: jsonBytes(options.params ?? {}),
				outcome,
				requestPreview: requestPreview(options.params ?? {}),
			})
		}
	}

	private async forwardApi(
		api: YiqichaApi,
		params: YiqichaParams,
		options: ForwardApiOptions = {},
	): Promise<UpstreamOutcome> {
		const settings = await this.requireStoredSettings()
		const cacheKey = makeCacheKey(api, params, settings.baseUrl)
		if (!options.noCache) {
			const cached = await this.readCachedOutcome(cacheKey)
			if (cached) return cached

			const pending = this.inflight.get(cacheKey.id)
			if (pending) {
				const outcome = await pending
				return cloneOutcome(outcome, {
					cacheCoalesced: true,
					cacheKey: cacheKey.id,
					units: 0,
				})
			}
		}

		const pending = this.forwardApiUncached(api, params, cacheKey, settings)
		if (!options.noCache) this.inflight.set(cacheKey.id, pending)
		try {
			return await pending
		} finally {
			if (!options.noCache) this.inflight.delete(cacheKey.id)
		}
	}

	private async forwardApiUncached(
		api: YiqichaApi,
		params: YiqichaParams,
		cacheKey: CacheKey,
		settings: ReadySettings,
	): Promise<UpstreamOutcome> {
		const request = this.createRequest(api, params, settings)
		const response = await fetch(request.url, request.init)
		const outcome = await this.toOutcome(response)
		const cacheStoredAt = outcome.ok ? await this.writeCachedOutcome(api, cacheKey, outcome) : undefined
		const headers = new Headers(outcome.response.headers)
		if (cacheStoredAt !== undefined) {
			headers.set('x-yiqicha-cache', 'MISS')
			headers.set('x-yiqicha-cache-stored-at', String(cacheStoredAt))
			headers.set('x-yiqicha-cache-age-ms', '0')
		}
		return {
			...outcome,
			response: new Response(outcome.bodyText ?? '', {
				status: outcome.response.status,
				headers,
			}),
			cacheHit: false,
			cacheKey: cacheKey.id,
			cacheAgeMs: cacheStoredAt === undefined ? undefined : 0,
			cacheStoredAt,
		}
	}

	private createRequest(api: YiqichaApi, params: YiqichaParams, settings: ReadySettings) {
		const method = api.requestMethod.toUpperCase()
		const timestamp = String(Date.now())
		const url = createApiUrl(api, params, settings.baseUrl)
		const headers = new Headers({
			'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
			'Auth-Version': 'v1',
			appkey: settings.appkey,
			timestamp,
			sign: createYiqichaSign(settings.appkey, timestamp, settings.secretKey),
		})
		const init: RequestInit = { method, headers }
		if (method !== 'GET') init.body = encodeParams(params)
		return { url, init }
	}

	private async toOutcome(response: Response): Promise<UpstreamOutcome> {
		const text = await response.text()
		const outputBytes = new TextEncoder().encode(text).length
		const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8'
		const headers = new Headers({ 'content-type': contentType })
		const upstreamRequestId =
			response.headers.get('x-request-id') ??
			response.headers.get('x-yiqicha-request-id') ??
			undefined
		if (upstreamRequestId) headers.set('x-upstream-request-id', upstreamRequestId)
		const business = parseYiqichaBusinessStatus(text, contentType)
		const ok = response.ok && business.ok
		const parsedError = ok
			? undefined
			: business.message
				? { message: business.message, code: business.code }
				: parseUpstreamError(text, contentType, response.status)
		return {
			response: new Response(text, { status: response.status, headers }),
			ok,
			status: business.status ?? String(response.status),
			error: parsedError?.message,
			errorCode: parsedError?.code,
			outputBytes,
			bodyText: text,
			upstreamRequestId: upstreamRequestId ?? parsedError?.requestId,
			units: 1,
			unitName: 'request',
		}
	}

	private async readCachedOutcome(cacheKey: CacheKey): Promise<UpstreamOutcome | undefined> {
		if (!this.data) return undefined
		try {
			const row = (
				await this.data.db
					.select()
					.from(yiqichaResponseCache)
					.where(eq(yiqichaResponseCache.id, cacheKey.id))
					.limit(1)
			)[0]
			if (!row) return undefined
			const now = Date.now()
			const cached = outcomeFromCacheRow(row, now)
			this.data.client
				.execute({
					sql: `
						UPDATE yiqicha_response_cache
						SET last_hit_at = ?, hit_count = hit_count + 1
						WHERE id = ?
					`,
					args: [now, cacheKey.id],
				})
				.catch((error) => {
					this.ctx.logger.warn('Failed to update YiQiCha response cache hit stats', {
						error,
						cacheKey: cacheKey.id,
					})
				})
			return cached
		} catch (error) {
			this.ctx.logger.warn('Failed to read YiQiCha response cache', { error, cacheKey: cacheKey.id })
			return undefined
		}
	}

	private async writeCachedOutcome(
		api: YiqichaApi,
		cacheKey: CacheKey,
		outcome: UpstreamOutcome,
	): Promise<number | undefined> {
		if (!this.data || !outcome.bodyText) return undefined
		try {
			const now = Date.now()
			await this.data.client.execute({
				sql: `
					INSERT INTO yiqicha_response_cache (
						id,
						api_code,
						api_key,
						params_json,
						status,
						http_status,
						content_type,
						body_text,
						output_bytes,
						upstream_request_id,
						created_at,
						updated_at,
						last_hit_at,
						hit_count
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
					ON CONFLICT(id) DO UPDATE SET
						api_code = excluded.api_code,
						api_key = excluded.api_key,
						params_json = excluded.params_json,
						status = excluded.status,
						http_status = excluded.http_status,
						content_type = excluded.content_type,
						body_text = excluded.body_text,
						output_bytes = excluded.output_bytes,
						upstream_request_id = excluded.upstream_request_id,
						updated_at = excluded.updated_at
				`,
				args: [
					cacheKey.id,
					api.apiCode,
					apiKeyByCode.get(api.apiCode) ?? api.apiCode,
					cacheKey.paramsJson,
					outcome.status,
					outcome.response.status,
					outcome.response.headers.get('content-type') ?? 'application/json; charset=utf-8',
					outcome.bodyText,
					outcome.outputBytes,
					outcome.upstreamRequestId ?? null,
					now,
					now,
				],
			})
			void this.trimResponseCache()
			return now
		} catch (error) {
			this.ctx.logger.warn('Failed to write YiQiCha response cache', { error, cacheKey: cacheKey.id })
			return undefined
		}
	}

	private async trimResponseCache(): Promise<void> {
		if (!this.data) return
		try {
			await this.data.client.execute({
				sql: `
					DELETE FROM yiqicha_response_cache
					WHERE id IN (
						SELECT id
						FROM yiqicha_response_cache
						ORDER BY COALESCE(last_hit_at, updated_at) DESC, updated_at DESC
						LIMIT -1 OFFSET ?
					)
				`,
				args: [MAX_YIQICHA_RESPONSE_CACHE_ROWS],
			})
		} catch (error) {
			this.ctx.logger.warn('Failed to trim YiQiCha response cache', { error })
		}
	}

	private recordUsage(input: {
		userId: string
		operation: string
		api?: YiqichaApi
		startedAt: number
		inputBytes: number
		outcome?: UpstreamOutcome
		metadata?: Record<string, unknown>
	}): void {
		const outcome = input.outcome ?? jsonOutcome({ ok: false, error: 'unknown outcome' }, 500)
		const latencyMs = Date.now() - input.startedAt
		this.updateStatus(outcome.ok, outcome.status, outcome.error)
		this.usageRecorder.recordUsage({
			userId: input.userId,
			provider: 'yiqicha',
			pluginId: this.ctx.pluginInfo.id,
			operation: input.operation,
			ok: outcome.ok,
			status: outcome.status,
			latencyMs,
			inputBytes: input.inputBytes,
			outputBytes: outcome.outputBytes,
			units: outcome.units ?? 1,
			unitName: outcome.unitName ?? 'request',
			upstreamRequestId: outcome.upstreamRequestId,
			metadata: {
				...(input.api
					? { apiCode: input.api.apiCode, apiName: input.api.apiName, cateName: input.api.cateName }
					: {}),
				cacheHit: outcome.cacheHit === true,
				...(outcome.cacheCoalesced ? { cacheCoalesced: true } : {}),
				...(outcome.cacheAgeMs !== undefined ? { cacheAgeMs: outcome.cacheAgeMs } : {}),
				...(outcome.cacheStoredAt !== undefined ? { cacheStoredAt: outcome.cacheStoredAt } : {}),
				...input.metadata,
				...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
				...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
			},
		})
	}

	private recordHistory(input: {
		source: YiqichaTestRunDoc['source']
		userId: string
		operation: string
		api?: YiqichaApi
		startedAt?: number
		latencyMs?: number
		inputBytes: number
		outputBytes?: number
		ok?: boolean
		status?: string
		error?: string
		outcome?: UpstreamOutcome
		requestPreview?: string
	}): void {
		const outcome = input.outcome
		const doc: YiqichaTestRunDoc = {
			id: String(this.historySeq++),
			at: Date.now(),
			source: input.source,
			userId: input.userId,
			operation: input.operation,
			...(input.api ? { apiCode: input.api.apiCode, apiName: input.api.apiName } : {}),
			ok: input.ok ?? outcome?.ok ?? false,
			status: input.status ?? outcome?.status ?? 'error',
			latencyMs: input.latencyMs ?? (input.startedAt ? Date.now() - input.startedAt : 0),
			inputBytes: Math.max(0, Math.floor(input.inputBytes)),
			outputBytes: Math.max(0, Math.floor(input.outputBytes ?? outcome?.outputBytes ?? 0)),
			...(outcome?.upstreamRequestId ? { upstreamRequestId: outcome.upstreamRequestId } : {}),
			...(input.requestPreview ? { requestPreview: truncate(input.requestPreview, 2_000) } : {}),
			...(outcome?.bodyText ? { responsePreview: truncate(outcome.bodyText, 8_000) } : {}),
			...((input.error ?? outcome?.error)
				? { error: truncate(input.error ?? outcome?.error ?? '', 2_000) }
				: {}),
		}
		this.history.insert(doc)
		void this.persistHistory(doc)
		this.trimHistory()
	}

	private async persistHistory(doc: YiqichaTestRunDoc): Promise<void> {
		if (!this.data) return
		try {
			await this.data.db.insert(yiqichaTestRuns).values(toHistoryRow(doc))
		} catch (error) {
			this.ctx.logger.warn('Failed to persist YiQiCha test history', { error })
		}
	}

	private async readStoredSettings(): Promise<StoredSettings> {
		const kv = this.kv()
		const baseUrl = (await kv.get<string>(KV_BASE_URL)) ?? DEFAULT_YIQICHA_BASE_URL
		const appkey = await kv.get<string>(KV_APPKEY)
		const secretKey = await kv.get<string>(KV_SECRET_KEY)
		return { appkey, secretKey, baseUrl }
	}

	private async requireStoredSettings(): Promise<ReadySettings> {
		const settings = await this.readStoredSettings()
		if (!settings.appkey) throw new Error('请先保存 YiQiCha App Key')
		if (!settings.secretKey) throw new Error('请先保存 YiQiCha Secret Key')
		return { ...settings, appkey: settings.appkey, secretKey: settings.secretKey }
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private async syncSettingsDoc(): Promise<YiqichaSettingsDoc> {
		const stored = await this.readStoredSettings()
		const doc: YiqichaSettingsDoc = {
			id: 'settings',
			hasAppkey: Boolean(stored.appkey),
			appkeyPreview: maskSecret(stored.appkey),
			hasSecretKey: Boolean(stored.secretKey),
			secretKeyPreview: maskSecret(stored.secretKey),
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
			.find({}, { limit: MAX_YIQICHA_HISTORY })
			.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0)
		this.historySeq = maxId + 1
	}

	private async loadHistoryFromDB(): Promise<void> {
		this.history.removeMany({})
		if (!this.data) {
			this.historySeq = 1
			return
		}
		const rows = await this.data.db
			.select()
			.from(yiqichaTestRuns)
			.orderBy(desc(yiqichaTestRuns.at))
			.limit(MAX_YIQICHA_HISTORY)
		for (const row of rows.toReversed()) this.history.insert(fromHistoryRow(row))
		this.restoreHistorySeq()
	}

	private trimHistory(): void {
		const all = this.history.find({}, { sort: { at: 1 } })
		const overflow = all.length - MAX_YIQICHA_HISTORY
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

setParamToken(YiqichaProviderPlugin, 0, UsageRecorderPlugin)

export class YiqichaProviderRpc extends RpcTarget {
	constructor(private readonly plugin: YiqichaProviderPlugin) {
		super()
	}

	saveSettings(input: { appkey?: string; secretKey?: string; baseUrl?: string }) {
		return this.plugin.saveSettings(input)
	}

	clearSecrets() {
		return this.plugin.clearSecrets()
	}

	testConnection(input?: { userId?: string; api?: string; keyword?: string }) {
		return this.plugin.testConnection(input)
	}

	clearHistory() {
		return this.plugin.clearHistory()
	}

	listHistory(limit?: number) {
		return this.plugin.listHistory(limit)
	}

	listCatalog(filter?: { keyword?: string; limit?: number }) {
		return this.plugin.listCatalog(filter)
	}

	getApiDoc(idOrCodeOrName: string) {
		return this.plugin.getApiDoc(idOrCodeOrName)
	}

	routeBase() {
		return this.plugin.routeBase()
	}
}

function requireYiqichaApi(idOrCodeOrName: string): YiqichaApi {
	const api = getYiqichaApi(idOrCodeOrName)
	if (!api) throw new Error(`Unknown YiQiCha API: ${idOrCodeOrName || '-'}`)
	return api
}

function createApiUrl(api: YiqichaApi, params: YiqichaParams, baseUrl: string): URL {
	const url = new URL(api.apiUrl)
	const base = new URL(baseUrl)
	url.protocol = base.protocol
	url.host = base.host
	if (api.requestMethod.toUpperCase() === 'GET') appendParams(url.searchParams, params)
	return url
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

function normalizeBaseUrl(input: string | undefined): string {
	const raw = input?.trim() || DEFAULT_YIQICHA_BASE_URL
	return raw.replace(/\/+$/, '')
}

function normalizeUserId(input: unknown): string | undefined {
	const value = typeof input === 'string' ? input.trim() : ''
	return value || undefined
}

function normalizeParams(input: unknown): YiqichaParams {
	if (input === undefined || input === null) return {}
	if (typeof input !== 'object' || Array.isArray(input)) throw new Error('params 必须是 JSON 对象')
	const output: YiqichaParams = {}
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (value == null) continue
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			output[key] = value
			continue
		}
		if (
			Array.isArray(value) &&
			value.every(
				(item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
			)
		) {
			output[key] = value
			continue
		}
		output[key] = JSON.stringify(value)
	}
	return output
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	if (typeof value === 'string' && value.trim()) return value.trim()
	return undefined
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

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key]
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
	return value
}

function compactApiDoc(api: YiqichaApi): YiqichaApiSummary {
	return {
		id: api.id,
		apiName: api.apiName,
		apiCode: api.apiCode,
		apiUrl: api.apiUrl,
		cateName: api.cateName,
		requestMethod: api.requestMethod,
		requiredParams: getYiqichaApiRequiredParams(api),
		unitPrice: api.unitPrice,
	}
}

function operationId(api: YiqichaApi | string | undefined): string {
	if (!api) return 'api.unknown'
	if (typeof api === 'string') return `api.${api.replace(/^api\./, '') || 'unknown'}`
	return `api.${apiKeyByCode.get(api.apiCode) ?? api.apiCode}`
}

function makeCacheKey(api: YiqichaApi, params: YiqichaParams, baseUrl: string): CacheKey {
	const rawParamsJson = stableParamsJson(params, { redactSensitiveValues: false })
	const fingerprint = `yiqicha:v1:${normalizeBaseUrl(baseUrl)}:${api.apiCode}:${rawParamsJson}`
	return {
		id: createHash('sha256').update(fingerprint).digest('hex'),
		paramsJson: stableParamsJson(params, { redactSensitiveValues: true }),
	}
}

function stableParamsJson(
	params: YiqichaParams,
	options: { redactSensitiveValues: boolean },
): string {
	const normalized: Record<string, string | string[]> = {}
	for (const key of Object.keys(params).sort()) {
		const value = params[key]
		if (value == null) continue
		if (options.redactSensitiveValues && isSensitiveParamKey(key)) {
			normalized[key] = '[redacted]'
			continue
		}
		normalized[key] = Array.isArray(value) ? value.map((item) => String(item)) : String(value)
	}
	return JSON.stringify(normalized)
}

function isSensitiveParamKey(key: string): boolean {
	return /(card|idcard|identity|mobile|phone|tel|email|password|secret|token)/i.test(key)
}

function outcomeFromCacheRow(row: YiqichaResponseCacheRow, now = Date.now()): UpstreamOutcome {
	const cacheAgeMs = Math.max(0, now - row.updatedAt)
	const headers = new Headers({
		'content-type': row.contentType,
		'x-yiqicha-cache': 'HIT',
		'x-yiqicha-cache-stored-at': String(row.updatedAt),
		'x-yiqicha-cache-age-ms': String(cacheAgeMs),
	})
	if (row.upstreamRequestId) headers.set('x-upstream-request-id', row.upstreamRequestId)
	return {
		response: new Response(row.bodyText, { status: row.httpStatus, headers }),
		ok: true,
		status: row.status,
		outputBytes: row.outputBytes,
		bodyText: row.bodyText,
		upstreamRequestId: row.upstreamRequestId ?? undefined,
		units: 0,
		unitName: 'request',
		cacheHit: true,
		cacheKey: row.id,
		cacheAgeMs,
		cacheStoredAt: row.updatedAt,
	}
}

function cloneOutcome(
	outcome: UpstreamOutcome,
	overrides: Partial<
		Pick<
			UpstreamOutcome,
			| 'cacheCoalesced'
			| 'cacheHit'
			| 'cacheKey'
			| 'units'
			| 'cacheAgeMs'
			| 'cacheStoredAt'
		>
	> = {},
): UpstreamOutcome {
	const headers = new Headers(outcome.response.headers)
	if (overrides.cacheHit) headers.set('x-yiqicha-cache', 'HIT')
	if (overrides.cacheCoalesced) headers.set('x-yiqicha-cache', 'COALESCED')
	if (overrides.cacheStoredAt !== undefined) {
		headers.set('x-yiqicha-cache-stored-at', String(overrides.cacheStoredAt))
	}
	if (overrides.cacheAgeMs !== undefined) headers.set('x-yiqicha-cache-age-ms', String(overrides.cacheAgeMs))
	return {
		...outcome,
		response: new Response(outcome.bodyText ?? '', {
			status: outcome.response.status,
			headers,
		}),
		...overrides,
	}
}

function toHistoryRow(doc: YiqichaTestRunDoc): YiqichaTestRunRow {
	return {
		id: doc.id,
		at: doc.at,
		source: doc.source,
		userId: doc.userId,
		operation: doc.operation,
		apiCode: doc.apiCode ?? null,
		apiName: doc.apiName ?? null,
		ok: doc.ok,
		status: doc.status,
		latencyMs: doc.latencyMs,
		inputBytes: doc.inputBytes,
		outputBytes: doc.outputBytes,
		upstreamRequestId: doc.upstreamRequestId ?? null,
		requestPreview: doc.requestPreview ?? null,
		responsePreview: doc.responsePreview ?? null,
		error: doc.error ?? null,
	}
}

function fromHistoryRow(row: YiqichaTestRunRow): YiqichaTestRunDoc {
	return {
		id: row.id,
		at: row.at,
		source: row.source,
		userId: row.userId,
		operation: row.operation,
		...(row.apiCode ? { apiCode: row.apiCode } : {}),
		...(row.apiName ? { apiName: row.apiName } : {}),
		ok: row.ok,
		status: row.status,
		latencyMs: row.latencyMs,
		inputBytes: row.inputBytes,
		outputBytes: row.outputBytes,
		...(row.upstreamRequestId ? { upstreamRequestId: row.upstreamRequestId } : {}),
		...(row.requestPreview ? { requestPreview: row.requestPreview } : {}),
		...(row.responsePreview ? { responsePreview: row.responsePreview } : {}),
		...(row.error ? { error: row.error } : {}),
	}
}

function parseYiqichaBusinessStatus(text: string, contentType: string) {
	if (!contentType.includes('application/json') || !text.trim()) {
		return { ok: true, status: undefined, message: undefined, code: undefined }
	}
	try {
		const payload = JSON.parse(text) as Record<string, unknown>
		const status = payload.status
		const code = payload.code
		const message = stringField(payload, 'message') ?? stringField(payload, 'msg')
		const businessOk =
			status === undefined
				? code === undefined || code === 0 || code === '0' || code === 200 || code === '200'
				: status === 200 || status === '200'
		return {
			ok: businessOk,
			status: status === undefined ? undefined : String(status),
			message: businessOk ? undefined : (message ?? text),
			code: code === undefined ? undefined : String(code),
		}
	} catch {
		return { ok: true, status: undefined, message: undefined, code: undefined }
	}
}

async function responsePayload(response: Response, outcome?: UpstreamOutcome): Promise<unknown> {
	const contentType = response.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) {
		const payload = await response.json()
		return attachGatewayCacheInfo(payload, outcome)
	}
	return response.text()
}

function attachGatewayCacheInfo(payload: unknown, outcome?: UpstreamOutcome): unknown {
	if (!outcome || outcome.cacheStoredAt === undefined) return payload
	const cacheInfo = {
		hit: outcome.cacheHit === true,
		coalesced: outcome.cacheCoalesced === true,
		storedAt: outcome.cacheStoredAt,
		storedAtIso: new Date(outcome.cacheStoredAt).toISOString(),
		ageMs: Math.max(0, Math.floor(outcome.cacheAgeMs ?? 0)),
		key: outcome.cacheKey,
	}
	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		return {
			...(payload as Record<string, unknown>),
			_gatewayCache: cacheInfo,
		}
	}
	return { data: payload, _gatewayCache: cacheInfo }
}

function jsonBytes(input: unknown): number {
	return new TextEncoder().encode(JSON.stringify(input)).length
}

function truncate(input: string, maxLength: number): string {
	return input.length > maxLength ? `${input.slice(0, maxLength)}...` : input
}

function maskSecret(secret: string | undefined): string | null {
	if (!secret) return null
	if (secret.length <= 10) return `${secret.slice(0, 2)}***${secret.slice(-2)}`
	return `${secret.slice(0, 6)}...${secret.slice(-4)}`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
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
