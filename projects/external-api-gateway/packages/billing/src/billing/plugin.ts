import { fileURLToPath } from 'node:url'
import '@pluxel/runtime/register/static'
import '@pluxel/runtime/services/web-management'
import { Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { ui } from '@pluxel/runtime/plugin'
import {
	DEFAULT_ZHIPU_CHAT_MODEL,
	DEFAULT_ZHIPU_LAYOUT_MODEL,
	DEFAULT_ZHIPU_TOKENIZER_MODEL,
	MAX_BILLING_RECORDS,
	UsageRecorderPlugin,
	billingRates,
	billingUsageRecords,
	type BillingRateRow,
	type BillingUsageRecordRow,
} from '@repo/external-api-gateway-shared'
import {
	type ExternalGatewayDbHandle,
	useExternalGatewayDB,
} from '@repo/external-api-gateway-shared/db'
import { yiqichaApiCodes, yiqichaCatalog } from '@repo/external-api-gateway-yiqicha-catalog'
import { desc } from 'drizzle-orm'
import type {
	BillingOverviewDoc,
	BillingProviderSummaryDoc,
	BillingRateDoc,
	BillingUsageInput,
	BillingUsageRecord,
	BillingUserSummaryDoc,
} from './contracts.ts'

const pluginUi = ui(fileURLToPath(new URL('./ui/index.tsx', import.meta.url)))
const OVERVIEW_DOC_ID = 'overview' as const
const yiqichaApiKeyByCode: Map<string, string> = new Map(
	Object.entries(yiqichaApiCodes).map(([key, code]) => [code, key]),
)

@Plugin(UsageRecorderPlugin, { name: 'UsageBillingPlugin' })
export class UsageBillingPlugin extends UsageRecorderPlugin {
	private overview = this.ctx.ext.signaldb.collection<BillingOverviewDoc>({ name: 'overview' })
	private records = this.ctx.ext.signaldb.collection<BillingUsageRecord>({ name: 'records' })
	private users = this.ctx.ext.signaldb.collection<BillingUserSummaryDoc>({ name: 'users' })
	private providers = this.ctx.ext.signaldb.collection<BillingProviderSummaryDoc>({
		name: 'providers',
	})
	private rates = this.ctx.ext.signaldb.collection<BillingRateDoc>({ name: 'rates' })
	private data: ExternalGatewayDbHandle | undefined
	private seq = 1

	override async init(): Promise<void> {
		await Promise.all([
			this.overview.ready(),
			this.records.ready(),
			this.users.ready(),
			this.providers.ready(),
			this.rates.ready(),
		])
		this.data = await useExternalGatewayDB(this.ctx)
		await this.loadRatesFromDB()
		this.seedDefaultRates()
		const usageRecords = await this.loadUsageFromDB()
		this.restoreSeq(usageRecords)
		this.rebuildSummaries(usageRecords)
		pluginUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new UsageBillingRpc(this))
		this.registerRoutes()
		this.ctx.logger.info('Usage billing ready')
	}

	recordUsage(input: BillingUsageInput): BillingUsageRecord {
		const now = Date.now()
		const units = Math.max(0, Number(input.units ?? 1) || 0)
		const estimatedCost = this.estimateCostCny(input.provider, input.operation, input.model, units)
		const costCny = roundMoney(input.costCny ?? estimatedCost)
		const metadata = normalizeUsageMetadata(input)
		const record: BillingUsageRecord = {
			...input,
			...(metadata ? { metadata } : {}),
			id: this.nextId(),
			at: now,
			currency: 'CNY',
			costEstimated: input.costCny === undefined,
			inputBytes: Math.max(0, Math.floor(input.inputBytes ?? 0)),
			outputBytes: Math.max(0, Math.floor(input.outputBytes ?? 0)),
			units,
			unitName: input.unitName ?? 'request',
			costCny,
		}

		this.records.insert(record)
		this.trimRecords()
		this.updateOverview(record)
		this.updateUserSummary(record)
		this.updateProviderSummary(record)
		void this.persistRecord(record)
		return { ...record }
	}

	listRecords(limit = 100): BillingUsageRecord[] {
		const capped = Math.max(0, Math.min(MAX_BILLING_RECORDS, Math.floor(limit)))
		return this.records.find({}, { limit: capped, sort: { at: -1 } })
	}

	listRates(): BillingRateDoc[] {
		return this.rates.find({}, { sort: { provider: 1, operation: 1, model: 1 } })
	}

	upsertRate(input: Omit<BillingRateDoc, 'id' | 'updatedAt'>): BillingRateDoc {
		const provider = input.provider.trim()
		const operation = input.operation.trim()
		const model = input.model?.trim() || undefined
		const unitName = input.unitName.trim() || 'request'
		if (!provider) throw new Error('Billing rate provider is required')
		if (!operation) throw new Error('Billing rate operation is required')
		const rate: BillingRateDoc = {
			provider,
			operation,
			...(model ? { model } : {}),
			unitName,
			id: rateId(provider, operation, model),
			unitCostCny: Math.max(0, Number(input.unitCostCny) || 0),
			updatedAt: Date.now(),
		}
		this.rates.replaceOne({ id: rate.id }, rate, { upsert: true })
		void this.persistRate(rate)
		return rate
	}

	clearUsage(): { ok: true } {
		this.records.removeMany({})
		this.users.removeMany({})
		this.providers.removeMany({})
		this.overview.replaceOne({ id: OVERVIEW_DOC_ID }, emptyOverview(), { upsert: true })
		this.seq = 1
		void this.data?.db.delete(billingUsageRecords).catch((error) => {
			this.ctx.logger.warn('Failed to clear billing usage database', { error })
		})
		return { ok: true }
	}

	private registerRoutes(): void {
		this.ctx.http.plugin.routes(
			(app) =>
				app.get('/status', () => ({
					ok: true,
					overview: this.overview.findOne({ id: OVERVIEW_DOC_ID }) ?? emptyOverview(),
					recent: this.listRecords(20),
				})),
			{
				path: '/billing',
				id: 'UsageBillingPlugin:http',
			},
		)
	}

	private seedDefaultRates(): void {
		const now = Date.now()
		const defaults: BillingRateDoc[] = [
			{
				id: 'zhipu:ocr.files',
				provider: 'zhipu',
				operation: 'ocr.files',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: `zhipu:ocr.layout_parsing:${DEFAULT_ZHIPU_LAYOUT_MODEL}`,
				provider: 'zhipu',
				operation: 'ocr.layout_parsing',
				model: DEFAULT_ZHIPU_LAYOUT_MODEL,
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:web_search',
				provider: 'zhipu',
				operation: 'web_search',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:file_parser.create',
				provider: 'zhipu',
				operation: 'file_parser.create',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:file_parser.result',
				provider: 'zhipu',
				operation: 'file_parser.result',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:file_parser.sync',
				provider: 'zhipu',
				operation: 'file_parser.sync',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:reader',
				provider: 'zhipu',
				operation: 'reader',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: `zhipu:chat.completions:${DEFAULT_ZHIPU_CHAT_MODEL}`,
				provider: 'zhipu',
				operation: 'chat.completions',
				model: DEFAULT_ZHIPU_CHAT_MODEL,
				unitName: 'token',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: `zhipu:tokenizer:${DEFAULT_ZHIPU_TOKENIZER_MODEL}`,
				provider: 'zhipu',
				operation: 'tokenizer',
				model: DEFAULT_ZHIPU_TOKENIZER_MODEL,
				unitName: 'token',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:embeddings.create',
				provider: 'zhipu',
				operation: 'embeddings.create',
				unitName: 'token',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:rerank.create',
				provider: 'zhipu',
				operation: 'rerank.create',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			{
				id: 'zhipu:moderations.create',
				provider: 'zhipu',
				operation: 'moderations.create',
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			},
			...yiqichaCatalog.apis.map((api) => ({
				id: `yiqicha:api.${yiqichaApiKeyByCode.get(api.apiCode) ?? api.apiCode}`,
				provider: 'yiqicha',
				operation: `api.${yiqichaApiKeyByCode.get(api.apiCode) ?? api.apiCode}`,
				unitName: 'request',
				unitCostCny: 0,
				updatedAt: now,
			})),
		]
		for (const rate of defaults) {
			if (this.rates.findOne({ id: rate.id })) continue
			this.rates.replaceOne({ id: rate.id }, rate, { upsert: true })
			void this.persistRate(rate)
		}
	}

	private estimateCostCny(
		provider: string,
		operation: string,
		model: string | undefined,
		units: number,
	) {
		const exactId = rateId(provider, operation, model)
		const fallbackId = rateId(provider, operation)
		const rate = this.rates.findOne({ id: exactId }) ?? this.rates.findOne({ id: fallbackId })
		return roundMoney((rate?.unitCostCny ?? 0) * units)
	}

	private updateOverview(record: BillingUsageRecord): void {
		const current = this.overview.findOne({ id: OVERVIEW_DOC_ID }) ?? emptyOverview()
		this.overview.replaceOne(
			{ id: OVERVIEW_DOC_ID },
			{
				id: OVERVIEW_DOC_ID,
				requestCount: current.requestCount + 1,
				successCount: current.successCount + (record.ok ? 1 : 0),
				errorCount: current.errorCount + (record.ok ? 0 : 1),
				totalCostCny: roundMoney(current.totalCostCny + record.costCny),
				totalLatencyMs: current.totalLatencyMs + record.latencyMs,
				totalInputBytes: current.totalInputBytes + record.inputBytes,
				totalOutputBytes: current.totalOutputBytes + record.outputBytes,
				updatedAt: record.at,
			},
			{ upsert: true },
		)
	}

	private updateUserSummary(record: BillingUsageRecord): void {
		const id = record.userId
		const current = this.users.findOne({ id })
		this.users.replaceOne(
			{ id },
			{
				id,
				userId: record.userId,
				requestCount: (current?.requestCount ?? 0) + 1,
				successCount: (current?.successCount ?? 0) + (record.ok ? 1 : 0),
				errorCount: (current?.errorCount ?? 0) + (record.ok ? 0 : 1),
				totalCostCny: roundMoney((current?.totalCostCny ?? 0) + record.costCny),
				totalLatencyMs: (current?.totalLatencyMs ?? 0) + record.latencyMs,
				updatedAt: record.at,
			},
			{ upsert: true },
		)
	}

	private updateProviderSummary(record: BillingUsageRecord): void {
		const id = `${record.provider}:${record.operation}`
		const current = this.providers.findOne({ id })
		this.providers.replaceOne(
			{ id },
			{
				id,
				provider: record.provider,
				operation: record.operation,
				requestCount: (current?.requestCount ?? 0) + 1,
				successCount: (current?.successCount ?? 0) + (record.ok ? 1 : 0),
				errorCount: (current?.errorCount ?? 0) + (record.ok ? 0 : 1),
				totalCostCny: roundMoney((current?.totalCostCny ?? 0) + record.costCny),
				totalLatencyMs: (current?.totalLatencyMs ?? 0) + record.latencyMs,
				updatedAt: record.at,
			},
			{ upsert: true },
		)
	}

	private trimRecords(): void {
		const all = this.records.find({}, { sort: { at: 1 } })
		const overflow = all.length - MAX_BILLING_RECORDS
		if (overflow <= 0) return
		for (const record of all.slice(0, overflow)) this.records.removeOne({ id: record.id })
	}

	private async loadRatesFromDB(): Promise<void> {
		this.rates.removeMany({})
		if (!this.data) return
		const rows = await this.data.db.select().from(billingRates)
		for (const row of rows) {
			this.rates.replaceOne({ id: row.id }, rateFromRow(row), { upsert: true })
		}
	}

	private async loadUsageFromDB(): Promise<BillingUsageRecord[]> {
		this.records.removeMany({})
		if (!this.data) return []
		const rows = await this.data.db
			.select()
			.from(billingUsageRecords)
			.orderBy(desc(billingUsageRecords.at))
		const allRecords = rows.map(recordFromRow)
		for (const record of allRecords.slice(0, MAX_BILLING_RECORDS).reverse()) {
			this.records.insert(record)
		}
		return allRecords
	}

	private rebuildSummaries(records: BillingUsageRecord[]): void {
		this.users.removeMany({})
		this.providers.removeMany({})
		this.overview.replaceOne({ id: OVERVIEW_DOC_ID }, emptyOverview(), { upsert: true })
		for (const record of records.slice().reverse()) {
			this.updateOverview(record)
			this.updateUserSummary(record)
			this.updateProviderSummary(record)
		}
	}

	private async persistRecord(record: BillingUsageRecord): Promise<void> {
		if (!this.data) return
		try {
			await this.data.db.insert(billingUsageRecords).values(recordToRow(record))
		} catch (error) {
			this.ctx.logger.warn('Failed to persist billing usage record', { error })
		}
	}

	private async persistRate(rate: BillingRateDoc): Promise<void> {
		if (!this.data) return
		try {
			await this.data.db
				.insert(billingRates)
				.values(rateToRow(rate))
				.onConflictDoUpdate({
					target: billingRates.id,
					set: rateToRow(rate),
				})
		} catch (error) {
			this.ctx.logger.warn('Failed to persist billing rate', { error })
		}
	}

	private restoreSeq(records: BillingUsageRecord[]): void {
		const maxId = records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0)
		this.seq = maxId + 1
	}

	private nextId(): string {
		const id = String(this.seq)
		this.seq += 1
		return id
	}
}

export class UsageBillingRpc extends RpcTarget {
	constructor(private readonly plugin: UsageBillingPlugin) {
		super()
	}

	clearUsage() {
		return this.plugin.clearUsage()
	}

	listRecords(limit?: number) {
		return this.plugin.listRecords(limit)
	}

	listRates() {
		return this.plugin.listRates()
	}

	upsertRate(input: Omit<BillingRateDoc, 'id' | 'updatedAt'>) {
		return this.plugin.upsertRate(input)
	}
}

function emptyOverview(): BillingOverviewDoc {
	return {
		id: OVERVIEW_DOC_ID,
		requestCount: 0,
		successCount: 0,
		errorCount: 0,
		totalCostCny: 0,
		totalLatencyMs: 0,
		totalInputBytes: 0,
		totalOutputBytes: 0,
		updatedAt: null,
	}
}

function roundMoney(value: number): number {
	return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000
}

function rateId(provider: string, operation: string, model?: string): string {
	return model ? `${provider}:${operation}:${model}` : `${provider}:${operation}`
}

function normalizeUsageMetadata(record: BillingUsageInput): Record<string, unknown> | undefined {
	const metadata = {
		...(record.metadata ?? {}),
		...(record.source ? { source: record.source } : {}),
		...(record.tenantId ? { tenantId: record.tenantId } : {}),
		...(record.traceId ? { traceId: record.traceId } : {}),
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined
}

function recordToRow(record: BillingUsageRecord): BillingUsageRecordRow {
	return {
		id: record.id,
		at: record.at,
		userId: record.userId,
		provider: record.provider,
		pluginId: record.pluginId,
		operation: record.operation,
		model: record.model ?? null,
		ok: record.ok,
		status: record.status,
		latencyMs: record.latencyMs,
		inputBytes: record.inputBytes,
		outputBytes: record.outputBytes,
		units: record.units,
		unitName: record.unitName,
		costCny: record.costCny,
		currency: record.currency,
		costEstimated: record.costEstimated,
		upstreamRequestId: record.upstreamRequestId ?? null,
		metadataJson: record.metadata ? JSON.stringify(record.metadata) : null,
	}
}

function recordFromRow(row: BillingUsageRecordRow): BillingUsageRecord {
	return {
		id: row.id,
		at: row.at,
		userId: row.userId,
		provider: row.provider,
		pluginId: row.pluginId,
		operation: row.operation,
		...(row.model ? { model: row.model } : {}),
		ok: row.ok,
		status: row.status,
		latencyMs: row.latencyMs,
		inputBytes: row.inputBytes,
		outputBytes: row.outputBytes,
		units: row.units,
		unitName: row.unitName,
		costCny: row.costCny,
		currency: row.currency === 'USD' ? 'USD' : 'CNY',
		costEstimated: row.costEstimated,
		...(row.upstreamRequestId ? { upstreamRequestId: row.upstreamRequestId } : {}),
		...(row.metadataJson ? { metadata: parseMetadata(row.metadataJson) } : {}),
	}
}

function rateToRow(rate: BillingRateDoc): BillingRateRow {
	return {
		id: rate.id,
		provider: rate.provider,
		operation: rate.operation,
		model: rate.model ?? null,
		unitName: rate.unitName,
		unitCostCny: rate.unitCostCny,
		updatedAt: rate.updatedAt,
	}
}

function rateFromRow(row: BillingRateRow): BillingRateDoc {
	return {
		id: row.id,
		provider: row.provider,
		operation: row.operation,
		...(row.model ? { model: row.model } : {}),
		unitName: row.unitName,
		unitCostCny: row.unitCostCny,
		updatedAt: row.updatedAt,
	}
}

function parseMetadata(input: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(input)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}
