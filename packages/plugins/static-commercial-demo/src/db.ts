export type CustomerTier = 'enterprise' | 'growth' | 'startup'
export type OrderStatus = 'draft' | 'review' | 'approved' | 'fulfilled'

export interface CustomerRecord {
	readonly id: string
	readonly name: string
	readonly owner: string
	readonly tier: CustomerTier
	readonly region: string
	healthScore: number
}

export interface OrderRecord {
	readonly id: string
	readonly customerId: string
	readonly sku: string
	status: OrderStatus
	amount: number
	margin: number
}

export interface PipelineSummary {
	readonly revenue: number
	readonly margin: number
	readonly openOrders: number
	readonly approvedOrders: number
}

interface CommercialDb {
	readonly startedAt: number
	readonly customers: CustomerRecord[]
	readonly orders: OrderRecord[]
}

declare global {
	var __pluxel_static_commercial_demo_db__: CommercialDb | undefined
}

function createInitialDb(): CommercialDb {
	return {
		startedAt: Date.now(),
		customers: [
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
		],
		orders: [
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
		],
	}
}

export const db: CommercialDb =
	globalThis.__pluxel_static_commercial_demo_db__ ?? createInitialDb()

if (process.env.NODE_ENV !== 'production') {
	globalThis.__pluxel_static_commercial_demo_db__ = db
}
