export type BillingCurrency = 'CNY' | 'USD'

export type BillingUsageInput = {
	userId: string
	provider: string
	pluginId: string
	operation: string
	model?: string
	ok: boolean
	status: string
	latencyMs: number
	inputBytes?: number
	outputBytes?: number
	units?: number
	unitName?: string
	costCny?: number
	upstreamRequestId?: string
	metadata?: Record<string, unknown>
}

export type BillingUsageRecord = BillingUsageInput & {
	id: string
	at: number
	currency: BillingCurrency
	costEstimated: boolean
	inputBytes: number
	outputBytes: number
	units: number
	unitName: string
}

export type BillingOverviewDoc = {
	id: 'overview'
	requestCount: number
	successCount: number
	errorCount: number
	totalCostCny: number
	totalLatencyMs: number
	totalInputBytes: number
	totalOutputBytes: number
	updatedAt: number | null
}

export type BillingUserSummaryDoc = {
	id: string
	userId: string
	requestCount: number
	successCount: number
	errorCount: number
	totalCostCny: number
	totalLatencyMs: number
	updatedAt: number
}

export type BillingProviderSummaryDoc = {
	id: string
	provider: string
	operation: string
	requestCount: number
	successCount: number
	errorCount: number
	totalCostCny: number
	totalLatencyMs: number
	updatedAt: number
}

export type BillingRateDoc = {
	id: string
	provider: string
	operation: string
	model?: string
	unitName: string
	unitCostCny: number
	updatedAt: number
}
