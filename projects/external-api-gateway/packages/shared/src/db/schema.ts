import type { InferSelectModel } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const historySources = ['ui', 'rpc', 'settings'] as const

export const gatewayMeta = sqliteTable('gateway_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
})

export const gatewayTokens = sqliteTable('gateway_tokens', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	tokenHash: text('token_hash').notNull(),
	tokenPreview: text('token_preview').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	lastUsedAt: integer('last_used_at'),
})

export const billingUsageRecords = sqliteTable(
	'billing_usage_records',
	{
		id: text('id').primaryKey(),
		at: integer('at').notNull(),
		userId: text('user_id').notNull(),
		provider: text('provider').notNull(),
		pluginId: text('plugin_id').notNull(),
		operation: text('operation').notNull(),
		model: text('model'),
		ok: integer('ok', { mode: 'boolean' }).notNull(),
		status: text('status').notNull(),
		latencyMs: integer('latency_ms').notNull(),
		inputBytes: integer('input_bytes').notNull(),
		outputBytes: integer('output_bytes').notNull(),
		units: real('units').notNull(),
		unitName: text('unit_name').notNull(),
		costCny: real('cost_cny').notNull(),
		currency: text('currency').notNull(),
		costEstimated: integer('cost_estimated', { mode: 'boolean' }).notNull(),
		upstreamRequestId: text('upstream_request_id'),
		metadataJson: text('metadata_json'),
	},
	(table) => ({
		atIdx: index('idx_billing_usage_records_at').on(table.at),
		providerOperationAtIdx: index('idx_billing_usage_records_provider_operation_at').on(
			table.provider,
			table.operation,
			table.at,
		),
		userAtIdx: index('idx_billing_usage_records_user_at').on(table.userId, table.at),
	}),
)

export const billingRates = sqliteTable('billing_rates', {
	id: text('id').primaryKey(),
	provider: text('provider').notNull(),
	operation: text('operation').notNull(),
	model: text('model'),
	unitName: text('unit_name').notNull(),
	unitCostCny: real('unit_cost_cny').notNull(),
	updatedAt: integer('updated_at').notNull(),
})

export const providerCallHistory = sqliteTable(
	'provider_call_history',
	{
		id: text('id').primaryKey(),
		provider: text('provider').notNull(),
		providerRecordId: text('provider_record_id').notNull(),
		at: integer('at').notNull(),
		source: text('source', { enum: historySources }).notNull(),
		userId: text('user_id').notNull(),
		operation: text('operation').notNull(),
		model: text('model'),
		ok: integer('ok', { mode: 'boolean' }).notNull(),
		status: text('status').notNull(),
		latencyMs: integer('latency_ms').notNull(),
		inputBytes: integer('input_bytes').notNull(),
		outputBytes: integer('output_bytes').notNull(),
		upstreamRequestId: text('upstream_request_id'),
		requestPreview: text('request_preview'),
		responsePreview: text('response_preview'),
		error: text('error'),
		detailsJson: text('details_json'),
	},
	(table) => ({
		providerAtIdx: index('idx_provider_call_history_provider_at').on(table.provider, table.at),
		providerRecordIdx: index('idx_provider_call_history_provider_record').on(
			table.provider,
			table.providerRecordId,
		),
	}),
)

export const yiqichaResponseCache = sqliteTable(
	'yiqicha_response_cache',
	{
		id: text('id').primaryKey(),
		apiCode: text('api_code').notNull(),
		apiKey: text('api_key').notNull(),
		paramsJson: text('params_json').notNull(),
		status: text('status').notNull(),
		httpStatus: integer('http_status').notNull(),
		contentType: text('content_type').notNull(),
		bodyText: text('body_text').notNull(),
		outputBytes: integer('output_bytes').notNull(),
		upstreamRequestId: text('upstream_request_id'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		lastHitAt: integer('last_hit_at'),
		hitCount: integer('hit_count').notNull(),
	},
	(table) => ({
		apiCodeIdx: index('idx_yiqicha_response_cache_api_code').on(table.apiCode),
		lastHitAtIdx: index('idx_yiqicha_response_cache_last_hit_at').on(table.lastHitAt),
		updatedAtIdx: index('idx_yiqicha_response_cache_updated_at').on(table.updatedAt),
	}),
)

export const gatewaySchema = {
	billingRates,
	billingUsageRecords,
	gatewayMeta,
	gatewayTokens,
	providerCallHistory,
	yiqichaResponseCache,
}

export type BillingRateRow = InferSelectModel<typeof billingRates>
export type BillingUsageRecordRow = InferSelectModel<typeof billingUsageRecords>
export type GatewayTokenRow = InferSelectModel<typeof gatewayTokens>
export type ProviderCallHistoryRow = InferSelectModel<typeof providerCallHistory>
export type YiqichaResponseCacheRow = InferSelectModel<typeof yiqichaResponseCache>
