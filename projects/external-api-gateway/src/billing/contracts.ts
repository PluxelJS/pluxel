import type { UsageCurrency, UsageEvent, UsageRecord } from '../usage/contracts'

export type BillingCurrency = UsageCurrency
export type BillingUsageInput = UsageEvent
export type BillingUsageRecord = UsageRecord

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
