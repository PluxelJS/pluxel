import { createHash, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import '@pluxel/runtime/register/static'
import '@pluxel/runtime/services/web-management'
import {
	DEFAULT_GATEWAY_DEV_TOKEN,
	type ExternalGatewayDbHandle,
	gatewayTokens,
	type GatewayTokenRow,
	useExternalGatewayDB,
} from '@repo/external-api-gateway-shared'
import type {
	GatewayAuthContext,
	GatewayBillingContext,
	GatewayStatusDoc,
	GatewayTokenCreateInput,
	GatewayTokenDoc,
} from '@repo/external-api-gateway-shared/gateway'
import type {
	ProviderCallInput,
	ProviderDescriptor,
	ProviderOperationDescriptor,
} from '@repo/external-api-gateway-shared/provider'
import { YiqichaProviderPlugin } from '@repo/external-api-gateway-yiqicha'
import type {
	YiqichaApiDoc,
	YiqichaApiSummary,
	YiqichaParams,
} from '@repo/external-api-gateway-yiqicha/provider'
import { ZhipuProviderPlugin } from '@repo/external-api-gateway-zhipu'
import type {
	ZhipuChatCompletionsInput,
	ZhipuEmbeddingInput,
	ZhipuFileParserResultInput,
	ZhipuFileParserUploadInput,
	ZhipuLayoutParsingInput,
	ZhipuModerationInput,
	ZhipuRawCallInput,
	ZhipuReaderInput,
	ZhipuRerankInput,
	ZhipuTokenizerInput,
	ZhipuUploadInput,
	ZhipuWebSearchInput,
} from '@repo/external-api-gateway-zhipu/provider'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime'
import { RpcTarget, newHttpBatchRpcResponse } from '@pluxel/runtime/capnweb'
import { ui } from '@pluxel/runtime/plugin'
import { desc, eq } from 'drizzle-orm'
import type { YiqichaApiKey } from '@repo/external-api-gateway-yiqicha-catalog'

const pluginUi = ui(fileURLToPath(new URL('./ui/index.tsx', import.meta.url)))
const ROUTE_BASE = '/gateway'
const RPC_PATH = `${ROUTE_BASE}/rpc`

@Plugin({ name: 'ExternalGatewayPlugin' })
export class ExternalGatewayPlugin extends BasePlugin {
	private tokens = this.ctx.ext.signaldb.collection<GatewayTokenDoc>({ name: 'tokens' })
	private status = this.ctx.ext.signaldb.collection<GatewayStatusDoc>({ name: 'status' })
	private tokenHashes = new Map<string, string>()
	private data: ExternalGatewayDbHandle | undefined

	constructor(
		private readonly zhipu: ZhipuProviderPlugin,
		private readonly yiqicha: YiqichaProviderPlugin,
	) {
		super()
	}

	override async init(): Promise<void> {
		await Promise.all([this.tokens.ready(), this.status.ready()])
		this.data = await useExternalGatewayDB(this.ctx)
		await this.loadTokensFromDB()
		await this.ensureDevToken()
		this.syncStatus()
		pluginUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new GatewayAdminRpc(this))
		this.registerRoutes()
		this.ctx.logger.info('External CapnWeb gateway ready', {
			rpcPath: this.ctx.http.plugin.base(RPC_PATH),
			dependsOn: [this.zhipu.ctx.pluginInfo.id, this.yiqicha.ctx.pluginInfo.id],
		})
	}

	async createToken(input: GatewayTokenCreateInput): Promise<GatewayTokenDoc> {
		const name = input.name.trim()
		const token = input.token.trim()
		if (!name) throw new Error('Token name is required')
		if (token.length < 12) throw new Error('Token must be at least 12 characters')
		const id = slugId(name)
		const now = Date.now()
		const doc: GatewayTokenDoc = {
			id,
			name,
			tokenPreview: previewToken(token),
			enabled: input.enabled ?? true,
			createdAt: this.tokens.findOne({ id })?.createdAt ?? now,
			updatedAt: now,
			lastUsedAt: this.tokens.findOne({ id })?.lastUsedAt ?? null,
		}
		const hash = tokenHash(token)
		this.tokenHashes.set(id, hash)
		this.tokens.replaceOne({ id }, doc, { upsert: true })
		await this.persistToken({ ...doc, tokenHash: hash })
		this.syncStatus()
		return doc
	}

	async revokeToken(id: string): Promise<{ ok: true }> {
		const existing = this.tokens.findOne({ id })
		if (!existing) return { ok: true }
		this.tokens.replaceOne(
			{ id },
			{ ...existing, enabled: false, updatedAt: Date.now() },
			{ upsert: true },
		)
		await this.data?.db
			.update(gatewayTokens)
			.set({ enabled: false, updatedAt: Date.now() })
			.where(eq(gatewayTokens.id, id))
		this.syncStatus()
		return { ok: true }
	}

	listTokens(): GatewayTokenDoc[] {
		return this.tokens.find({}, { sort: { updatedAt: -1 } })
	}

	listProviders(): ProviderDescriptor[] {
		return [this.zhipu.descriptor(), this.yiqicha.descriptor()]
	}

	async authenticate(apiToken: string): Promise<GatewayAuthContext> {
		const token = apiToken.trim()
		if (!token) throw new Error('Missing API token')
		for (const doc of this.tokens.find({}, { limit: 200 })) {
			if (!doc.enabled) continue
			const expected = this.tokenHashes.get(doc.id)
			if (!expected) continue
			if (!constantTimeEquals(expected, tokenHash(token))) continue
			const next = { ...doc, lastUsedAt: Date.now(), updatedAt: Date.now() }
			this.tokens.replaceOne({ id: doc.id }, next, { upsert: true })
			await this.data?.db
				.update(gatewayTokens)
				.set({ lastUsedAt: next.lastUsedAt, updatedAt: next.updatedAt })
				.where(eq(gatewayTokens.id, doc.id))
			return {
				tokenId: doc.id,
				name: doc.name,
			}
		}
		throw new Error('Invalid API token')
	}

	rpcBase(): string {
		return this.ctx.http.plugin.base(RPC_PATH)
	}

	private registerRoutes(): void {
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/status', () => ({
						ok: true,
						rpc: this.rpcBase(),
						tokens: this.listTokens(),
						providers: this.listProviders(),
					}))
					.all(
						'/rpc',
						async ({ request, set }) => {
							try {
								return await newHttpBatchRpcResponse(request, new ExternalGatewayRpc(this))
							} catch (error) {
								this.ctx.logger.error('External gateway RPC failed', { error })
								set.status = 500
								return 'External gateway RPC error'
							}
						},
						{ parse: 'none' },
					),
			{
				path: ROUTE_BASE,
				id: 'ExternalGatewayPlugin:http',
			},
		)
	}

	private async ensureDevToken(): Promise<void> {
		const explicitToken = process.env.PLUXEL_EXTERNAL_GATEWAY_DEV_TOKEN
		if (process.env.NODE_ENV === 'production' && !explicitToken) return
		const token = explicitToken ?? DEFAULT_GATEWAY_DEV_TOKEN
		const existing = this.tokens.findOne({ id: 'local-dev' })
		if (existing) {
			await this.createToken({
				name: existing.name,
				token,
				enabled: existing.enabled,
			})
			return
		}
		if (this.tokens.count() > 0) return
		await this.createToken({
			name: 'local-dev',
			token,
		})
	}

	private syncStatus(): void {
		const all = this.tokens.find({}, { limit: 500 })
		this.status.replaceOne(
			{ id: 'status' },
			{
				id: 'status',
				rpcPath: this.ctx.http.plugin.base(RPC_PATH),
				tokenCount: all.length,
				enabledTokenCount: all.filter((token) => token.enabled).length,
				updatedAt: Date.now(),
			},
			{ upsert: true },
		)
	}

	private async loadTokensFromDB(): Promise<void> {
		this.tokens.removeMany({})
		this.tokenHashes.clear()
		if (!this.data) return
		const rows = await this.data.db
			.select()
			.from(gatewayTokens)
			.orderBy(desc(gatewayTokens.updatedAt))
		for (const row of rows.toReversed()) {
			const doc = tokenDocFromRow(row)
			this.tokens.replaceOne({ id: doc.id }, doc, { upsert: true })
			this.tokenHashes.set(row.id, row.tokenHash)
		}
	}

	private async persistToken(row: GatewayTokenRow): Promise<void> {
		if (!this.data) return
		await this.data.db
			.insert(gatewayTokens)
			.values(row)
			.onConflictDoUpdate({
				target: gatewayTokens.id,
				set: {
					name: row.name,
					tokenHash: row.tokenHash,
					tokenPreview: row.tokenPreview,
					enabled: row.enabled,
					updatedAt: row.updatedAt,
					lastUsedAt: row.lastUsedAt,
				},
			})
	}

	apiFor(auth: GatewayAuthContext): AuthedApi {
		return new AuthedApi(this, auth)
	}

	billedApi(billing: GatewayBillingContext): BilledApi {
		return new BilledApi(this, billing)
	}

	get zhipuProvider(): ZhipuProviderPlugin {
		return this.zhipu
	}

	get yiqichaProvider(): YiqichaProviderPlugin {
		return this.yiqicha
	}
}

setParamToken(ExternalGatewayPlugin, 0, ZhipuProviderPlugin)
setParamToken(ExternalGatewayPlugin, 1, YiqichaProviderPlugin)

export class ExternalGatewayRpc extends RpcTarget {
	constructor(private readonly gateway: ExternalGatewayPlugin) {
		super()
	}

	async authenticate(apiToken: string): Promise<AuthedApi> {
		return this.gateway.apiFor(await this.gateway.authenticate(apiToken))
	}

	status() {
		return {
			ok: true,
			rpc: this.gateway.rpcBase(),
			providers: this.gateway.listProviders(),
		}
	}
}

export class AuthedApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly auth: GatewayAuthContext,
	) {
		super()
	}

	whoami(): GatewayAuthContext {
		return this.auth
	}

	bill(input: string | GatewayBillingContext): BilledApi {
		const billing =
			typeof input === 'string'
				? { userId: requireUserId(input) }
				: { ...input, userId: requireUserId(input.userId) }
		return this.gateway.billedApi(billing)
	}
}

export class BilledApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	billingContext(): GatewayBillingContext {
		return this.billing
	}

	providers(): ProviderDescriptor[] {
		return this.gateway.listProviders()
	}

	provider(providerId: string): GenericProviderGatewayApi {
		return new GenericProviderGatewayApi(this.gateway, this.billing, requireProviderId(providerId))
	}

	zhipu(): ZhipuGatewayApi {
		return new ZhipuGatewayApi(this.gateway, this.billing)
	}

	yiqicha(): YiqichaGatewayApi {
		return new YiqichaGatewayApi(this.gateway, this.billing)
	}
}

export class GenericProviderGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
		private readonly providerId: string,
	) {
		super()
	}

	call(input: ProviderCallInput): Promise<unknown> {
		const operationId = requireOperationId(input.operation)
		const descriptor = this.gateway
			.listProviders()
			.find((provider) => provider.id === this.providerId)
		if (!descriptor) throw new Error(`Unknown provider: ${this.providerId}`)
		const operation = descriptor.operations.find((item) => item.id === operationId)
		const path = input.path?.trim() || operation?.path
		if (!path)
			throw new Error(`Provider operation requires path: ${this.providerId}:${operationId}`)
		if (this.providerId === 'zhipu') {
			const method = input.method?.trim().toUpperCase() || operation?.method || 'POST'
			const prepared = prepareZhipuGenericCall({
				input,
				method,
				operation,
				operationId,
				path,
			})
			return this.gateway.zhipuProvider.gatewayRaw(this.billing, {
				method,
				path: prepared.path,
				body: prepared.body,
				operation: operationId,
				model: input.model ?? operation?.defaultModel,
			})
		}
		if (this.providerId === 'yiqicha') {
			return this.gateway.yiqichaProvider.gatewayRaw(this.billing, {
				api: path.replace(/^api\./, ''),
				params: normalizeYiqichaParams(input.body),
				operation: operationId,
			})
		}
		throw new Error(`Provider is not callable: ${this.providerId}`)
	}
}

export class YiqichaGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	findApis(input: { query?: string; limit?: number } = {}): YiqichaApiSummary[] {
		return this.gateway.yiqichaProvider.listCatalog({
			keyword: input.query,
			limit: input.limit,
		})
	}

	getApiSchema(input: { api: YiqichaApiKey | string }): YiqichaApiDoc {
		return this.gateway.yiqichaProvider.getApiDoc(input.api)
	}

	callApi(input: { api: YiqichaApiKey | string; params?: YiqichaParams }): Promise<unknown> {
		return this.callLoose(input.api, input.params ?? {})
	}

	async getEnterpriseProfile(input: {
		keyword: string
		include?: Array<
			'basicInfo' | 'shareholders' | 'investments' | 'branches' | 'changeRecords' | 'contacts'
		>
		pageSize?: number
	}): Promise<Record<string, unknown>> {
		const keyword = requireKeyword(input.keyword)
		const include = includeSet(input.include, [
			'basicInfo',
			'shareholders',
			'investments',
			'branches',
		])
		const listParams = pageParams(keyword, input.pageSize)
		return collectDefined({
			...(include.has('basicInfo')
				? { basicInfo: await this.callLoose('getBasicInfo', { keyword }) }
				: {}),
			...(include.has('shareholders')
				? { shareholders: await this.callLoose('getEnterprisePartners', listParams) }
				: {}),
			...(include.has('investments')
				? { investments: await this.callLoose('getInvestEnterprise', listParams) }
				: {}),
			...(include.has('branches')
				? { branches: await this.callLoose('branchEnterprise', listParams) }
				: {}),
			...(include.has('changeRecords')
				? { changeRecords: await this.callLoose('alterEnterprise', listParams) }
				: {}),
			...(include.has('contacts')
				? { contacts: await this.callLoose('contractDetailEnterpriseList', listParams) }
				: {}),
		})
	}

	async getEnterpriseRiskOverview(input: {
		keyword: string
		include?: Array<
			| 'abnormalOperations'
			| 'seriousIllegalRecords'
			| 'stockPledges'
			| 'administrativePenalties'
			| 'chattelMortgages'
			| 'liquidationRisks'
		>
		pageSize?: number
	}): Promise<Record<string, unknown>> {
		const keyword = requireKeyword(input.keyword)
		const include = includeSet(input.include, [
			'abnormalOperations',
			'seriousIllegalRecords',
			'stockPledges',
			'administrativePenalties',
		])
		const params = pageParams(keyword, input.pageSize)
		return collectDefined({
			...(include.has('abnormalOperations')
				? { abnormalOperations: await this.callLoose('entAbnormalList1031', params) }
				: {}),
			...(include.has('seriousIllegalRecords')
				? { seriousIllegalRecords: await this.callLoose('entIllegalList', params) }
				: {}),
			...(include.has('stockPledges')
				? { stockPledges: await this.callLoose('getStockInfoList', params) }
				: {}),
			...(include.has('administrativePenalties')
				? { administrativePenalties: await this.callLoose('penaltyListVo', params) }
				: {}),
			...(include.has('chattelMortgages')
				? { chattelMortgages: await this.callLoose('entMortList', params) }
				: {}),
			...(include.has('liquidationRisks')
				? { liquidationRisks: await this.callLoose('cleanRiskList', params) }
				: {}),
		})
	}

	async getEnterpriseLegalOverview(input: {
		keyword: string
		include?: Array<
			| 'enforcementCases'
			| 'dishonestExecutions'
			| 'courtAnnouncements'
			| 'judgmentDocuments'
			| 'highConsumptionLimits'
			| 'bankruptcyReorganizations'
		>
		pageSize?: number
	}): Promise<Record<string, unknown>> {
		const keyword = requireKeyword(input.keyword)
		const include = includeSet(input.include, [
			'enforcementCases',
			'dishonestExecutions',
			'courtAnnouncements',
			'judgmentDocuments',
		])
		const params = pageParams(keyword, input.pageSize)
		return collectDefined({
			...(include.has('enforcementCases')
				? { enforcementCases: await this.callLoose('lawEnforceInfoList', params) }
				: {}),
			...(include.has('dishonestExecutions')
				? { dishonestExecutions: await this.callLoose('lawDishonestList', params) }
				: {}),
			...(include.has('courtAnnouncements')
				? { courtAnnouncements: await this.callLoose('lawOpenAnnoList', params) }
				: {}),
			...(include.has('judgmentDocuments')
				? { judgmentDocuments: await this.callLoose('lawRefereeDocList', params) }
				: {}),
			...(include.has('highConsumptionLimits')
				? { highConsumptionLimits: await this.callLoose('limitHighInfoList', params) }
				: {}),
			...(include.has('bankruptcyReorganizations')
				? {
						bankruptcyReorganizations: await this.callLoose('bankruptcyReorganizationList', params),
					}
				: {}),
		})
	}

	private callLoose(api: YiqichaApiKey | string, params: YiqichaParams): Promise<unknown> {
		return this.gateway.yiqichaProvider.gatewayCallApi(this.billing, api, params)
	}
}

export class ZhipuGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	ocr(): ZhipuOcrGatewayApi {
		return new ZhipuOcrGatewayApi(this.gateway, this.billing)
	}

	models(): ZhipuModelsGatewayApi {
		return new ZhipuModelsGatewayApi(this.gateway, this.billing)
	}

	embeddings(): ZhipuEmbeddingsGatewayApi {
		return new ZhipuEmbeddingsGatewayApi(this.gateway, this.billing)
	}

	rerank(): ZhipuRerankGatewayApi {
		return new ZhipuRerankGatewayApi(this.gateway, this.billing)
	}

	tools(): ZhipuToolsGatewayApi {
		return new ZhipuToolsGatewayApi(this.gateway, this.billing)
	}

	moderations(): ZhipuModerationsGatewayApi {
		return new ZhipuModerationsGatewayApi(this.gateway, this.billing)
	}

	search(): ZhipuSearchGatewayApi {
		return new ZhipuSearchGatewayApi(this.gateway, this.billing)
	}

	openapi(): ZhipuOpenApiGatewayApi {
		return new ZhipuOpenApiGatewayApi(this.gateway, this.billing)
	}

	raw(input: ZhipuRawCallInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayRaw(this.billing, input)
	}
}

export class ZhipuModelsGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	chatCompletions(input: ZhipuChatCompletionsInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayChatCompletions(this.billing, input)
	}

	tokenizer(input: ZhipuTokenizerInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayTokenizer(this.billing, input)
	}
}

export class ZhipuOpenApiGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	request(input: ZhipuRawCallInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayRaw(this.billing, input)
	}
}

export class ZhipuEmbeddingsGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	create(input: ZhipuEmbeddingInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayEmbeddings(this.billing, input)
	}
}

export class ZhipuRerankGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	create(input: ZhipuRerankInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayRerank(this.billing, input)
	}
}

export class ZhipuToolsGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	reader(input: ZhipuReaderInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayReader(this.billing, input)
	}

	fileParser(): ZhipuFileParserGatewayApi {
		return new ZhipuFileParserGatewayApi(this.gateway, this.billing)
	}
}

export class ZhipuFileParserGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	create(input: ZhipuFileParserUploadInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayFileParserCreate(this.billing, input)
	}

	result(input: ZhipuFileParserResultInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayFileParserResult(this.billing, input)
	}

	sync(input: ZhipuFileParserUploadInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayFileParserSync(this.billing, input)
	}
}

export class ZhipuModerationsGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	create(input: ZhipuModerationInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayModerations(this.billing, input)
	}
}

export class ZhipuOcrGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	layoutParsing(input: ZhipuLayoutParsingInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayLayoutParsing(this.billing, input)
	}

	filesOcr(input: ZhipuUploadInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayFilesOcr(this.billing, input)
	}
}

export class ZhipuSearchGatewayApi extends RpcTarget {
	constructor(
		private readonly gateway: ExternalGatewayPlugin,
		private readonly billing: GatewayBillingContext,
	) {
		super()
	}

	webSearch(input: ZhipuWebSearchInput): Promise<unknown> {
		return this.gateway.zhipuProvider.gatewayWebSearch(this.billing, input)
	}
}

export class GatewayAdminRpc extends RpcTarget {
	constructor(private readonly gateway: ExternalGatewayPlugin) {
		super()
	}

	createToken(input: GatewayTokenCreateInput) {
		return this.gateway.createToken(input)
	}

	revokeToken(id: string) {
		return this.gateway.revokeToken(id)
	}

	listTokens() {
		return this.gateway.listTokens()
	}

	rpcBase() {
		return this.gateway.rpcBase()
	}
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	return left.length === right.length && timingSafeEqual(left, right)
}

function previewToken(token: string): string {
	if (token.length <= 10) return `${token.slice(0, 2)}***${token.slice(-2)}`
	return `${token.slice(0, 6)}...${token.slice(-4)}`
}

function slugId(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, '-')
			.replaceAll(/^-+|-+$/g, '') || `token-${Date.now()}`
	)
}

function requireProviderId(providerId: string): string {
	const value = providerId.trim()
	if (!value) throw new Error('Provider id is required')
	return value
}

function prepareZhipuGenericCall(input: {
	input: ProviderCallInput
	method: string
	operation?: ProviderOperationDescriptor
	operationId: string
	path: string
}): { path: string; body: ProviderCallInput['body'] | undefined } {
	if (input.operation?.inputKind === 'multipart') {
		throw new Error(
			`Zhipu operation ${input.operationId} requires multipart upload; use the typed Zhipu RPC wrapper or plugin UI.`,
		)
	}
	const path = input.path.includes('{')
		? interpolatePathTemplate(input.path, genericBodyRecord(input.input.body))
		: input.path
	const body = input.method === 'GET' || input.method === 'HEAD' ? undefined : input.input.body
	return { path, body }
}

function interpolatePathTemplate(path: string, body: Record<string, unknown> | undefined): string {
	return path.replaceAll(/\{([^}]+)\}/g, (_match, key: string) => {
		const value = body?.[key] ?? body?.[camelCase(key)]
		if (value === undefined || value === null || value === '') {
			throw new Error(`Provider path requires body field: ${key}`)
		}
		return encodeURIComponent(String(value))
	})
}

function genericBodyRecord(body: ProviderCallInput['body']): Record<string, unknown> | undefined {
	if (body === undefined || body === null) return undefined
	if (typeof body === 'string') {
		const parsed = JSON.parse(body) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Provider path body must be a JSON object')
		}
		return parsed as Record<string, unknown>
	}
	return body
}

function camelCase(input: string): string {
	return input.replaceAll(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function normalizeYiqichaParams(input: ProviderCallInput['body']): YiqichaParams {
	if (input === undefined || input === null) return {}
	const value = typeof input === 'string' ? JSON.parse(input) : input
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('YiQiCha provider body must be a JSON object')
	}
	const params: YiqichaParams = {}
	for (const [key, item] of Object.entries(value)) {
		if (item == null) continue
		if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
			params[key] = item
			continue
		}
		if (
			Array.isArray(item) &&
			item.every(
				(value) =>
					typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
			)
		) {
			params[key] = item
			continue
		}
		params[key] = JSON.stringify(item)
	}
	return params
}

function requireKeyword(keyword: string): string {
	const value = keyword.trim()
	if (!value) throw new Error('keyword is required')
	return value
}

function pageParams(keyword: string, pageSize = 5): YiqichaParams {
	return {
		keyword,
		page: 1,
		pageSize: Math.max(1, Math.min(20, Math.floor(Number(pageSize) || 5))),
	}
}

function includeSet<T extends string>(input: T[] | undefined, defaults: readonly T[]): Set<T> {
	return new Set(input?.length ? input : defaults)
}

function collectDefined(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function tokenDocFromRow(row: GatewayTokenRow): GatewayTokenDoc {
	return {
		id: row.id,
		name: row.name,
		tokenPreview: row.tokenPreview,
		enabled: row.enabled,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastUsedAt: row.lastUsedAt,
	}
}

function requireUserId(userId: string): string {
	const value = userId.trim()
	if (!value) throw new Error('Billing userId is required')
	return value
}

function requireOperationId(operationId: string): string {
	const value = operationId.trim()
	if (!value) throw new Error('Provider operation is required')
	return value
}
