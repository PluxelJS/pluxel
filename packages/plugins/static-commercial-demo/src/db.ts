import type { InferSelectModel } from 'drizzle-orm'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export type CustomerTier = 'enterprise' | 'growth' | 'startup'
export type OrderStatus = 'draft' | 'review' | 'approved' | 'fulfilled'

const customerTiers = ['enterprise', 'growth', 'startup'] as const
const orderStatuses = ['draft', 'review', 'approved', 'fulfilled'] as const

export const customers = sqliteTable('customers', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	owner: text('owner').notNull(),
	tier: text('tier', { enum: customerTiers }).notNull(),
	region: text('region').notNull(),
	healthScore: integer('health_score').notNull(),
})

export const orders = sqliteTable('orders', {
	id: text('id').primaryKey(),
	customerId: text('customer_id')
		.notNull()
		.references(() => customers.id, { onDelete: 'cascade' }),
	sku: text('sku').notNull(),
	status: text('status', { enum: orderStatuses }).notNull(),
	amount: integer('amount').notNull(),
	margin: real('margin').notNull(),
})

export const commercialSchema = {
	customers,
	orders,
}

export type CustomerRecord = InferSelectModel<typeof customers>
export type OrderRecord = InferSelectModel<typeof orders>

export interface PipelineSummary {
	readonly revenue: number
	readonly margin: number
	readonly openOrders: number
	readonly approvedOrders: number
}

export const seedCustomers: readonly CustomerRecord[] = [
	{
		id: 'c_aurora',
		name: 'Aurora Retail Group',
		owner: 'Mira Chen',
		tier: 'enterprise',
		region: 'APAC',
		healthScore: 91,
	},
	{
		id: 'c_northstar',
		name: 'Northstar Logistics',
		owner: 'Theo Grant',
		tier: 'growth',
		region: 'NA',
		healthScore: 76,
	},
	{
		id: 'c_lumen',
		name: 'Lumen Labs',
		owner: 'Iris Vega',
		tier: 'startup',
		region: 'EU',
		healthScore: 83,
	},
]

export const seedOrders: readonly OrderRecord[] = [
	{
		id: 'o_1001',
		customerId: 'c_aurora',
		sku: 'Static Runtime Enterprise',
		status: 'review',
		amount: 128000,
		margin: 0.42,
	},
	{
		id: 'o_1002',
		customerId: 'c_aurora',
		sku: 'Plugin Governance Pack',
		status: 'approved',
		amount: 64000,
		margin: 0.51,
	},
	{
		id: 'o_1003',
		customerId: 'c_northstar',
		sku: 'Fleet Workflow Extensions',
		status: 'draft',
		amount: 42000,
		margin: 0.36,
	},
	{
		id: 'o_1004',
		customerId: 'c_lumen',
		sku: 'Developer Seat Bundle',
		status: 'fulfilled',
		amount: 18000,
		margin: 0.58,
	},
]
