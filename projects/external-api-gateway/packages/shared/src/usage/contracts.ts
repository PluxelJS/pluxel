import { BasePlugin } from '@pluxel/runtime'

export type UsageSource = 'ui' | 'rpc' | 'settings' | 'system'
export type UsageCurrency = 'CNY' | 'USD'
export type UsageUnitName = 'request' | 'token' | 'page' | 'image' | string

export type UsageEvent = {
	source?: UsageSource
	userId: string
	tenantId?: string
	traceId?: string
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
	unitName?: UsageUnitName
	costCny?: number
	upstreamRequestId?: string
	metadata?: Record<string, unknown>
}

export type UsageRecord = UsageEvent & {
	id: string
	at: number
	currency: UsageCurrency
	costEstimated: boolean
	inputBytes: number
	outputBytes: number
	units: number
	unitName: UsageUnitName
}

export type UsageRecorder = {
	recordUsage(input: UsageEvent): UsageRecord
}

export abstract class UsageRecorderPlugin extends BasePlugin implements UsageRecorder {
	abstract recordUsage(input: UsageEvent): UsageRecord
}
