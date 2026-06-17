import type { CustomerRecord, db, OrderRecord, OrderStatus, PipelineSummary } from './db.ts'

export function createCommercialServices(database: typeof db) {
	return {
		customers(): readonly CustomerRecord[] {
			return database.customers
		},

		customer(id: string): CustomerRecord | null {
			return database.customers.find((customer) => customer.id === id) ?? null
		},

		orders(): readonly OrderRecord[] {
			return database.orders
		},

		order(id: string): OrderRecord | null {
			return database.orders.find((order) => order.id === id) ?? null
		},

		ordersByCustomer(customerId: string): readonly OrderRecord[] {
			return database.orders.filter((order) => order.customerId === customerId)
		},

		customerForOrder(order: OrderRecord): CustomerRecord {
			return mustFind(database.customers, order.customerId, 'Customer')
		},

		summary(): PipelineSummary {
			const revenue = database.orders.reduce((total, order) => total + order.amount, 0)
			const margin = Math.round(
				database.orders.reduce((total, order) => total + order.amount * order.margin, 0),
			)
			return {
				revenue,
				margin,
				openOrders: database.orders.filter((order) => order.status !== 'fulfilled').length,
				approvedOrders: database.orders.filter((order) => order.status === 'approved').length,
			}
		},

		approveOrder(id: string): OrderRecord {
			const order = mustFind(database.orders, id, 'Order')
			order.status = 'approved'
			return order
		},

		updateOrderAmount(id: string, amount: number): OrderRecord {
			const order = mustFind(database.orders, id, 'Order')
			order.amount = amount
			return order
		},

		setCustomerHealth(id: string, score: number): CustomerRecord {
			const customer = mustFind(database.customers, id, 'Customer')
			customer.healthScore = score
			return customer
		},

		ordersByStatus(status: OrderStatus): readonly OrderRecord[] {
			return database.orders.filter((order) => order.status === status)
		},
	}
}

function mustFind<T extends { readonly id: string }>(
	records: readonly T[],
	id: string,
	typeName: string,
): T {
	const record = records.find((item) => item.id === id)
	if (!record) {
		throw new Error(`${typeName} not found: ${id}`)
	}
	return record
}
