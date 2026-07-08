import type { InferSelectModel } from 'drizzle-orm'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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

export const billingUsageRecords = sqliteTable('billing_usage_records', {
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
})

export const billingRates = sqliteTable('billing_rates', {
	id: text('id').primaryKey(),
	provider: text('provider').notNull(),
	operation: text('operation').notNull(),
	model: text('model'),
	unitName: text('unit_name').notNull(),
	unitCostCny: real('unit_cost_cny').notNull(),
	updatedAt: integer('updated_at').notNull(),
})

export const zhipuTestRuns = sqliteTable('zhipu_test_runs', {
	id: text('id').primaryKey(),
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
	fileName: text('file_name'),
	upstreamRequestId: text('upstream_request_id'),
	requestPreview: text('request_preview'),
	responsePreview: text('response_preview'),
	error: text('error'),
})

export const yiqichaTestRuns = sqliteTable('yiqicha_test_runs', {
	id: text('id').primaryKey(),
	at: integer('at').notNull(),
	source: text('source', { enum: historySources }).notNull(),
	userId: text('user_id').notNull(),
	operation: text('operation').notNull(),
	apiCode: text('api_code'),
	apiName: text('api_name'),
	ok: integer('ok', { mode: 'boolean' }).notNull(),
	status: text('status').notNull(),
	latencyMs: integer('latency_ms').notNull(),
	inputBytes: integer('input_bytes').notNull(),
	outputBytes: integer('output_bytes').notNull(),
	upstreamRequestId: text('upstream_request_id'),
	requestPreview: text('request_preview'),
	responsePreview: text('response_preview'),
	error: text('error'),
})

export const gatewaySchema = {
	billingRates,
	billingUsageRecords,
	gatewayMeta,
	gatewayTokens,
	yiqichaTestRuns,
	zhipuTestRuns,
}

export type BillingRateRow = InferSelectModel<typeof billingRates>
export type BillingUsageRecordRow = InferSelectModel<typeof billingUsageRecords>
export type GatewayTokenRow = InferSelectModel<typeof gatewayTokens>
export type YiqichaTestRunRow = InferSelectModel<typeof yiqichaTestRuns>
export type ZhipuTestRunRow = InferSelectModel<typeof zhipuTestRuns>
