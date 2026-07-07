import { createHash, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime'
import { RpcTarget, newHttpBatchRpcResponse } from '@pluxel/runtime/capnweb'
import { ui } from '@pluxel/runtime/plugin'
import { desc, eq } from 'drizzle-orm'
import { UsageBillingPlugin } from '../billing/plugin.ts'
import { gatewayTokens, type GatewayTokenRow } from '../db/schema.ts'
import { type ExternalGatewayDbHandle, useExternalGatewayDB } from '../db/use-db.ts'
import { ZhipuProviderPlugin } from '../zhipu/plugin.ts'
import type {
	ZhipuChatCompletionsInput,
	ZhipuEmbeddingInput,
	ZhipuLayoutParsingInput,
	ZhipuModerationInput,
	ZhipuRawCallInput,
	ZhipuReaderInput,
	ZhipuRerankInput,
	ZhipuUploadInput,
	ZhipuWebSearchInput,
} from '../zhipu/provider.ts'
import type {
	GatewayAuthContext,
	GatewayBillingContext,
	GatewayStatusDoc,
	GatewayTokenCreateInput,
	GatewayTokenDoc,
} from './contracts.ts'

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
		private readonly billing: UsageBillingPlugin,
		private readonly zhipu: ZhipuProviderPlugin,
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
			dependsOn: [this.billing.ctx.pluginInfo.id, this.zhipu.ctx.pluginInfo.id],
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
		const token = process.env.PLUXEL_EXTERNAL_GATEWAY_DEV_TOKEN ?? 'dev-zhipu-token-change-me'
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
		for (const row of rows.slice().reverse()) {
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
}

setParamToken(ExternalGatewayPlugin, 0, UsageBillingPlugin)
setParamToken(ExternalGatewayPlugin, 1, ZhipuProviderPlugin)

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

	zhipu(): ZhipuGatewayApi {
		return new ZhipuGatewayApi(this.gateway, this.billing)
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
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || `token-${Date.now()}`
	)
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
