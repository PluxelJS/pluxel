import { createHash, timingSafeEqual } from 'node:crypto'
import '@pluxel/runtime/register/static'
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
import { YiqichaProviderPlugin } from '@repo/external-api-gateway-yiqicha'
import { ZhipuProviderPlugin } from '@repo/external-api-gateway-zhipu'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import { RpcTarget, newHttpBatchRpcResponse } from 'capnweb'
import { desc, eq } from 'drizzle-orm'
import {
	listExternalGatewayToolSpecs,
	type ExternalGatewayToolBatchCallInput,
	type ExternalGatewayToolBatchCallResult,
	type ExternalGatewayToolCallInput,
	type ExternalGatewayToolCallResultItem,
	type ExternalGatewayToolListInput,
	type ExternalGatewayToolSpec,
} from './tools.ts'
import { callExternalGatewayTool } from './tool-dispatcher.ts'

export {
	EXTERNAL_GATEWAY_TOOL_NAMES,
	EXTERNAL_GATEWAY_TOOL_SPECS,
	listExternalGatewayToolSpecs,
	type ExternalGatewayToolArgs,
	type ExternalGatewayJsonSchema,
	type ExternalGatewayToolBatchCallInput,
	type ExternalGatewayToolBatchCallResult,
	type ExternalGatewayToolCallInput,
	type ExternalGatewayToolCallResultItem,
	type ExternalGatewayToolExample,
	type ExternalGatewayToolListInput,
	type ExternalGatewayToolMetadata,
	type ExternalGatewayToolName,
	type ExternalGatewayToolProvider,
	type ExternalGatewayToolResult,
	type ExternalGatewayToolSpec,
	type YiqichaBundleKind,
	type YiqichaBundleRecommendation,
	type YiqichaRecommendedCall,
} from './tools.ts'

const pluginUi = ui(import.meta.url, './ui/index.tsx')
export const EXTERNAL_GATEWAY_ROUTE_BASE = '/external-gateway'
export const EXTERNAL_GATEWAY_RPC_PATH = `${EXTERNAL_GATEWAY_ROUTE_BASE}/rpc`

@Plugin({ name: 'ExternalGatewayPlugin' })
export class ExternalGatewayPlugin extends BasePlugin {
	private tokens!: ManagementStateCollection<GatewayTokenDoc>
	private status!: ManagementStateCollection<GatewayStatusDoc>
	private tokenHashes = new Map<string, string>()
	private data: ExternalGatewayDbHandle | undefined

	constructor(
		private readonly zhipu: ZhipuProviderPlugin,
		private readonly yiqicha: YiqichaProviderPlugin,
	) {
		super()
	}

	override async init(): Promise<void> {
		await this.ctx.webManagement.use(async (web) => {
			this.tokens = web.state.collection<GatewayTokenDoc>({ name: 'tokens' })
			this.status = web.state.collection<GatewayStatusDoc>({ name: 'status' })
			await Promise.all([this.tokens.ready(), this.status.ready()])
			this.data = await useExternalGatewayDB(this.ctx)
			await this.loadTokensFromDB()
			await this.ensureDevToken()
			this.syncStatus()
			web.ui.register(pluginUi)
			web.rpc.expose(() => new GatewayAdminRpc(this))
		})
		this.registerRoutes()
		this.ctx.logger.info('External CapnWeb gateway ready', {
			rpcPath: this.rpcBase(),
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
		return EXTERNAL_GATEWAY_RPC_PATH
	}

	private registerRoutes(): void {
		const buildRoutes = (app: ReturnType<typeof this.ctx.http.host.app>) =>
			app
				.get('/status', () => ({
					ok: true,
					rpc: this.rpcBase(),
				}))
				.get('/tools', ({ query }) =>
					listExternalGatewayToolSpecs({
						provider:
							typeof query.provider === 'string'
								? (query.provider as ExternalGatewayToolListInput['provider'])
								: undefined,
					}),
				)
				.post('/call', async ({ request }) => {
					const api = this.apiFor(await this.authenticate(requestToken(request)))
					return api.callTool((await request.json()) as ExternalGatewayToolCallInput)
				})
				.post('/call-batch', async ({ request }) => {
					const api = this.apiFor(await this.authenticate(requestToken(request)))
					return api.callTools((await request.json()) as ExternalGatewayToolBatchCallInput)
				})
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
				)
		this.ctx.http.host.routes(buildRoutes, {
			path: EXTERNAL_GATEWAY_ROUTE_BASE,
			id: 'ExternalGatewayPlugin:external-http',
		})
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
				rpcPath: this.rpcBase(),
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

	toolSpecs(input: ExternalGatewayToolListInput = {}): ExternalGatewayToolSpec[] {
		return listExternalGatewayToolSpecs(input)
	}

	callTool(input: ExternalGatewayToolCallInput): Promise<unknown> {
		return callExternalGatewayTool(
			this.gateway,
			normalizeBillingInput(input.billing),
			input.name,
			input.args,
		)
	}

	async callTools(
		input: ExternalGatewayToolBatchCallInput,
	): Promise<ExternalGatewayToolBatchCallResult> {
		if (!Array.isArray(input.calls)) throw new Error('calls must be an array')
		const results = await Promise.all(
			input.calls.map(async (call, index): Promise<ExternalGatewayToolCallResultItem> => {
				try {
					return {
						index,
						name: call.name,
						ok: true,
						result: await this.callTool(call),
					}
				} catch (caught) {
					return {
						index,
						name: call.name,
						ok: false,
						error: errorMessage(caught),
					}
				}
			}),
		)
		return { results }
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

function normalizeBillingInput(input: string | GatewayBillingContext): GatewayBillingContext {
	return typeof input === 'string'
		? { userId: requireUserId(input) }
		: { ...input, userId: requireUserId(input.userId) }
}

function requestToken(request: Request): string {
	const authorization = request.headers.get('authorization') ?? ''
	const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
	const token = bearer || request.headers.get('x-api-token')?.trim()
	if (!token) throw new Error('Missing gateway API token')
	return token
}

function errorMessage(caught: unknown): string {
	if (caught instanceof Error) return caught.message
	return String(caught)
}
