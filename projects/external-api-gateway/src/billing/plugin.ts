import { fileURLToPath } from 'node:url'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { ui } from '@pluxel/runtime/plugin'
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
const MAX_RECORDS = 500

@Plugin({ name: 'UsageBillingPlugin' })
export class UsageBillingPlugin extends BasePlugin {
	private overview = this.ctx.ext.signaldb.collection<BillingOverviewDoc>({ name: 'overview' })
	private records = this.ctx.ext.signaldb.collection<BillingUsageRecord>({ name: 'records' })
	private users = this.ctx.ext.signaldb.collection<BillingUserSummaryDoc>({ name: 'users' })
	private providers = this.ctx.ext.signaldb.collection<BillingProviderSummaryDoc>({
		name: 'providers',
	})
	private rates = this.ctx.ext.signaldb.collection<BillingRateDoc>({ name: 'rates' })
	private seq = 1

	override async init(): Promise<void> {
		await Promise.all([
			this.overview.ready(),
			this.records.ready(),
			this.users.ready(),
			this.providers.ready(),
			this.rates.ready(),
		])
		this.restoreSeq()
		this.ensureOverview()
		this.seedDefaultRates()
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
		const record: BillingUsageRecord = {
			...input,
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
		return { ...record }
	}

	listRecords(limit = 100): BillingUsageRecord[] {
		const capped = Math.max(0, Math.min(MAX_RECORDS, Math.floor(limit)))
		return this.records.find({}, { limit: capped, sort: { at: -1 } })
	}

	listRates(): BillingRateDoc[] {
		return this.rates.find({}, { sort: { provider: 1, operation: 1, model: 1 } })
	}

	upsertRate(input: Omit<BillingRateDoc, 'id' | 'updatedAt'>): BillingRateDoc {
		const rate: BillingRateDoc = {
			...input,
			id: rateId(input.provider, input.operation, input.model),
			unitCostCny: Math.max(0, Number(input.unitCostCny) || 0),
			updatedAt: Date.now(),
		}
		this.rates.replaceOne({ id: rate.id }, rate, { upsert: true })
		return rate
	}

	clearUsage(): { ok: true } {
		this.records.removeMany({})
		this.users.removeMany({})
		this.providers.removeMany({})
		this.overview.replaceOne({ id: OVERVIEW_DOC_ID }, emptyOverview(), { upsert: true })
		this.seq = 1
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

	private ensureOverview(): void {
		if (this.overview.findOne({ id: OVERVIEW_DOC_ID })) return
		this.overview.insert(emptyOverview())
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
					id: 'zhipu:ocr.layout_parsing:glm-ocr',
					provider: 'zhipu',
				operation: 'ocr.layout_parsing',
				model: 'glm-ocr',
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
					id: 'zhipu:reader',
					provider: 'zhipu',
					operation: 'reader',
					unitName: 'request',
					unitCostCny: 0,
					updatedAt: now,
				},
				{
					id: 'zhipu:chat.completions',
					provider: 'zhipu',
					operation: 'chat.completions',
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
			]
		for (const rate of defaults) {
			this.rates.replaceOne({ id: rate.id }, rate, { upsert: true })
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
		const overflow = all.length - MAX_RECORDS
		if (overflow <= 0) return
		for (const record of all.slice(0, overflow)) this.records.removeOne({ id: record.id })
	}

	private restoreSeq(): void {
		const maxId = this.records
			.find({}, { limit: MAX_RECORDS })
			.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0)
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
