import type { InferSelectModel } from 'drizzle-orm'
import {
	bigint,
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
} from 'drizzle-orm/pg-core'
import { defineDatabase } from '@pluxel/runtime/database'

const historySources = ['ui', 'rpc', 'settings'] as const

export const gatewayTokens = pgTable('gateway_tokens', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	tokenHash: text('token_hash').notNull(),
	tokenPreview: text('token_preview').notNull(),
	enabled: boolean('enabled').notNull(),
	createdAt: bigint('created_at', { mode: 'number' }).notNull(),
	updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
	lastUsedAt: bigint('last_used_at', { mode: 'number' }),
})

export const billingUsageRecords = pgTable(
	'billing_usage_records',
	{
		id: text('id').primaryKey(),
		at: bigint('at', { mode: 'number' }).notNull(),
		userId: text('user_id').notNull(),
		provider: text('provider').notNull(),
		pluginId: text('plugin_id').notNull(),
		operation: text('operation').notNull(),
		model: text('model'),
		ok: boolean('ok').notNull(),
		status: text('status').notNull(),
		latencyMs: integer('latency_ms').notNull(),
		inputBytes: integer('input_bytes').notNull(),
		outputBytes: integer('output_bytes').notNull(),
		units: doublePrecision('units').notNull(),
		unitName: text('unit_name').notNull(),
		costCny: doublePrecision('cost_cny').notNull(),
		currency: text('currency').notNull(),
		costEstimated: boolean('cost_estimated').notNull(),
		upstreamRequestId: text('upstream_request_id'),
		metadataJson: text('metadata_json'),
	},
	(table) => [
		index('idx_billing_usage_records_at').on(table.at),
		index('idx_billing_usage_records_provider_operation_at').on(
			table.provider,
			table.operation,
			table.at,
		),
		index('idx_billing_usage_records_user_at').on(table.userId, table.at),
	],
)

export const billingRates = pgTable('billing_rates', {
	id: text('id').primaryKey(),
	provider: text('provider').notNull(),
	operation: text('operation').notNull(),
	model: text('model'),
	unitName: text('unit_name').notNull(),
	unitCostCny: doublePrecision('unit_cost_cny').notNull(),
	updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const providerCallHistory = pgTable(
	'provider_call_history',
	{
		id: text('id').primaryKey(),
		provider: text('provider').notNull(),
		providerRecordId: text('provider_record_id').notNull(),
		at: bigint('at', { mode: 'number' }).notNull(),
		source: text('source', { enum: historySources }).notNull(),
		userId: text('user_id').notNull(),
		operation: text('operation').notNull(),
		model: text('model'),
		ok: boolean('ok').notNull(),
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
	(table) => [
		index('idx_provider_call_history_provider_at').on(table.provider, table.at),
		index('idx_provider_call_history_provider_record').on(table.provider, table.providerRecordId),
	],
)

export const yiqichaResponseCache = pgTable(
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
		createdAt: bigint('created_at', { mode: 'number' }).notNull(),
		updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
		lastHitAt: bigint('last_hit_at', { mode: 'number' }),
		hitCount: integer('hit_count').notNull(),
	},
	(table) => [
		index('idx_yiqicha_response_cache_api_code').on(table.apiCode),
		index('idx_yiqicha_response_cache_last_hit_at').on(table.lastHitAt),
		index('idx_yiqicha_response_cache_updated_at').on(table.updatedAt),
	],
)

export const workbenchProjections = pgTable(
	'workbench_projections',
	{
		resource: text('resource').notNull(),
		id: text('id').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
		position: integer('position').notNull(),
		updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.resource, table.id] }),
		index('workbench_projections_resource_position_idx').on(table.resource, table.position),
	],
)

export const gatewaySchema = {
	billingRates,
	billingUsageRecords,
	gatewayTokens,
	providerCallHistory,
	yiqichaResponseCache,
	workbenchProjections,
}

export const externalGatewayDatabase = defineDatabase({ schema: gatewaySchema })

export type BillingRateRow = InferSelectModel<typeof billingRates>
export type BillingUsageRecordRow = InferSelectModel<typeof billingUsageRecords>
export type GatewayTokenRow = InferSelectModel<typeof gatewayTokens>
export type ProviderCallHistoryRow = InferSelectModel<typeof providerCallHistory>
export type YiqichaResponseCacheRow = InferSelectModel<typeof yiqichaResponseCache>
