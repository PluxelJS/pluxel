import { createRequire } from 'node:module'
import { resolver, mutation, query, silk } from '@gqloom/core'
import { ValibotWeaver, asEnumType, asObjectType } from '@gqloom/valibot'
import * as v from 'valibot'
import type { CommercialContext } from './context.ts'
import type { OrderStatus } from './db.ts'

const require = createRequire(import.meta.url)
const { printSchema } = require('graphql') as typeof import('graphql')
const id = () => v.nonOptional(v.string())
const gqlMetadata = (metadata: unknown): Record<string, unknown> => metadata as Record<string, unknown>

export const CustomerTierSchema = v.pipe(
	v.picklist(['enterprise', 'growth', 'startup']),
	v.metadata(gqlMetadata(asEnumType('CustomerTier'))),
)

export const OrderStatusSchema = v.pipe(
	v.picklist(['draft', 'review', 'approved', 'fulfilled']),
	v.metadata(gqlMetadata(asEnumType('OrderStatus'))),
)

export const PipelineSummarySchema = v.pipe(
	v.object({
		revenue: v.nonOptional(v.number()),
		margin: v.nonOptional(v.number()),
		openOrders: v.nonOptional(v.number()),
		approvedOrders: v.nonOptional(v.number()),
	}),
	v.metadata(gqlMetadata(asObjectType('PipelineSummary'))),
)

export const CustomerSchema = v.pipe(
	v.object({
		id: v.nonOptional(v.string()),
		name: v.nonOptional(v.string()),
		owner: v.nonOptional(v.string()),
		tier: v.nonOptional(CustomerTierSchema),
		region: v.nonOptional(v.string()),
		healthScore: v.nonOptional(v.number()),
	}),
	v.metadata(gqlMetadata(asObjectType('Customer'))),
)

export const OrderSchema = v.pipe(
	v.object({
		id: v.nonOptional(v.string()),
		customerId: v.nonOptional(v.string()),
		sku: v.nonOptional(v.string()),
		status: v.nonOptional(OrderStatusSchema),
		amount: v.nonOptional(v.number()),
		margin: v.nonOptional(v.number()),
	}),
	v.metadata(gqlMetadata(asObjectType('Order'))),
)

const commercialResolver = resolver({
	summary: query(PipelineSummarySchema).resolve((_args, payload) => {
		const context = payload?.context as CommercialContext
		return context.services.summary()
	}),
	customers: query(silk.list(CustomerSchema)).resolve((_args, payload) => {
		const context = payload?.context as CommercialContext
		return [...context.services.customers()]
	}),
	customer: query(CustomerSchema)
		.input({ id: id() })
		.resolve(({ id: customerId }, payload) => {
			const context = payload?.context as CommercialContext
			return context.services.customer(customerId)
		}),
	orders: query(silk.list(OrderSchema)).resolve((_args, payload) => {
		const context = payload?.context as CommercialContext
		return [...context.services.orders()]
	}),
	order: query(OrderSchema)
		.input({ id: id() })
		.resolve(({ id: orderId }, payload) => {
			const context = payload?.context as CommercialContext
			return context.services.order(orderId)
		}),
	ordersByStatus: query(silk.list(OrderSchema))
		.input({ status: OrderStatusSchema })
		.resolve(({ status }, payload) => {
			const context = payload?.context as CommercialContext
			return [...context.services.ordersByStatus(status as OrderStatus)]
		}),
	approveOrder: mutation(OrderSchema)
		.input({ id: id() })
		.resolve(({ id: orderId }, payload) => {
			const context = payload?.context as CommercialContext
			return context.services.approveOrder(orderId)
		}),
	updateOrderAmount: mutation(OrderSchema)
		.input({ id: id(), amount: v.nonOptional(v.number()) })
		.resolve(({ id: orderId, amount }, payload) => {
			const context = payload?.context as CommercialContext
			return context.services.updateOrderAmount(orderId, amount)
		}),
	setCustomerHealth: mutation(CustomerSchema)
		.input({ id: id(), score: v.nonOptional(v.number()) })
		.resolve(({ id: customerId, score }, payload) => {
			const context = payload?.context as CommercialContext
			return context.services.setCustomerHealth(customerId, score)
		}),
})

export function createSchema() {
	return ValibotWeaver.weave(commercialResolver)
}

export function createSchemaSDL(): string {
	return printSchema(createSchema())
}
