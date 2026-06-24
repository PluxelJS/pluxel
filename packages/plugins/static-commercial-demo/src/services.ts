import { count, eq, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import {
	commercialSchema,
	customers as customersTable,
	orders as ordersTable,
	type CustomerRecord,
	type OrderRecord,
	type OrderStatus,
	type PipelineSummary,
} from './db.ts'
import { CommercialServiceError } from './errors.ts'

export type CommercialDatabase = LibSQLDatabase<typeof commercialSchema>

export function createCommercialServices(database: CommercialDatabase) {
	return {
		async customers(): Promise<readonly CustomerRecord[]> {
			return await database.select().from(customersTable).all()
		},

		async customer(id: string): Promise<CustomerRecord | null> {
			assertId(id, 'customer id')
			return (
				(await database.select().from(customersTable).where(eq(customersTable.id, id)).get()) ??
				null
			)
		},

		async orders(): Promise<readonly OrderRecord[]> {
			return await database.select().from(ordersTable).all()
		},

		async order(id: string): Promise<OrderRecord | null> {
			assertId(id, 'order id')
			return (await database.select().from(ordersTable).where(eq(ordersTable.id, id)).get()) ?? null
		},

		async ordersByCustomer(customerId: string): Promise<readonly OrderRecord[]> {
			assertId(customerId, 'customer id')
			return await database
				.select()
				.from(ordersTable)
				.where(eq(ordersTable.customerId, customerId))
				.all()
		},

		async customerForOrder(order: OrderRecord): Promise<CustomerRecord> {
			return mustReturn(
				await database
					.select()
					.from(customersTable)
					.where(eq(customersTable.id, order.customerId))
					.get(),
				order.customerId,
				'Customer',
			)
		},

		async summary(): Promise<PipelineSummary> {
			const [summary] = await database
				.select({
					revenue: sql<number>`coalesce(sum(${ordersTable.amount}), 0)`,
					margin: sql<number>`coalesce(round(sum(${ordersTable.amount} * ${ordersTable.margin})), 0)`,
					openOrders: sql<number>`coalesce(sum(case when ${ordersTable.status} != 'fulfilled' then 1 else 0 end), 0)`,
					approvedOrders: sql<number>`coalesce(sum(case when ${ordersTable.status} = 'approved' then 1 else 0 end), 0)`,
				})
				.from(ordersTable)
				.all()

			return {
				revenue: summary?.revenue ?? 0,
				margin: summary?.margin ?? 0,
				openOrders: summary?.openOrders ?? 0,
				approvedOrders: summary?.approvedOrders ?? 0,
			}
		},

		async approveOrder(id: string): Promise<OrderRecord> {
			assertId(id, 'order id')
			return mustReturn(
				await database
					.update(ordersTable)
					.set({ status: 'approved' })
					.where(eq(ordersTable.id, id))
					.returning()
					.get(),
				id,
				'Order',
			)
		},

		async updateOrderAmount(id: string, amount: number): Promise<OrderRecord> {
			assertId(id, 'order id')
			assertAmount(amount)
			return mustReturn(
				await database
					.update(ordersTable)
					.set({ amount })
					.where(eq(ordersTable.id, id))
					.returning()
					.get(),
				id,
				'Order',
			)
		},

		async setCustomerHealth(id: string, score: number): Promise<CustomerRecord> {
			assertId(id, 'customer id')
			assertHealthScore(score)
			return mustReturn(
				await database
					.update(customersTable)
					.set({ healthScore: score })
					.where(eq(customersTable.id, id))
					.returning()
					.get(),
				id,
				'Customer',
			)
		},

		async ordersByStatus(status: OrderStatus): Promise<readonly OrderRecord[]> {
			return await database.select().from(ordersTable).where(eq(ordersTable.status, status)).all()
		},

		async customerCount(): Promise<number> {
			const result = await database.select({ value: count() }).from(customersTable).get()
			return result?.value ?? 0
		},
	}
}

export type CommercialServices = ReturnType<typeof createCommercialServices>

function assertId(value: string, label: string): void {
	if (value.trim().length > 0) return
	throw new CommercialServiceError('COMMERCIAL_INVALID_INPUT', `${label} must not be empty`, {
		details: { field: label },
	})
}

function assertAmount(value: number): void {
	if (Number.isFinite(value) && value > 0) return
	throw new CommercialServiceError('COMMERCIAL_INVALID_INPUT', 'Order amount must be positive', {
		details: { field: 'amount', value },
	})
}

function assertHealthScore(value: number): void {
	if (Number.isInteger(value) && value >= 0 && value <= 100) return
	throw new CommercialServiceError(
		'COMMERCIAL_INVALID_INPUT',
		'Customer health score must be an integer from 0 to 100',
		{
			details: { field: 'score', value, min: 0, max: 100 },
		},
	)
}

function mustReturn<T extends { readonly id: string }>(
	record: T | undefined,
	id: string,
	typeName: string,
): T {
	if (record) return record
	throw new CommercialServiceError('COMMERCIAL_NOT_FOUND', `${typeName} not found: ${id}`, {
		details: { typeName, id },
	})
}
