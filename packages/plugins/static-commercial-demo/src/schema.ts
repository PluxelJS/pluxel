import { createRequire } from 'node:module'
import { resolver, mutation, query, silk } from '@gqloom/core'
import { ValibotWeaver, asEnumType, asObjectType } from '@gqloom/valibot'
import { GraphQLError } from 'graphql'
import * as v from 'valibot'
import type { CommercialContext } from './context.ts'
import type { OrderStatus } from './db.ts'
import { isCommercialServiceError } from './errors.ts'

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
	summary: query(PipelineSummarySchema).resolve(async (_args, payload) => {
		return await resolveCommercial(payload, (context) => context.services.summary())
	}),
	customers: query(silk.list(CustomerSchema)).resolve(async (_args, payload) => {
		return await resolveCommercial(payload, async (context) => [
			...(await context.services.customers()),
		])
	}),
	customer: query(CustomerSchema)
		.input({ id: id() })
		.resolve(async ({ id: customerId }, payload) => {
			return await resolveCommercial(payload, (context) => context.services.customer(customerId))
		}),
	orders: query(silk.list(OrderSchema)).resolve(async (_args, payload) => {
		return await resolveCommercial(payload, async (context) => [
			...(await context.services.orders()),
		])
	}),
	order: query(OrderSchema)
		.input({ id: id() })
		.resolve(async ({ id: orderId }, payload) => {
			return await resolveCommercial(payload, (context) => context.services.order(orderId))
		}),
	ordersByStatus: query(silk.list(OrderSchema))
		.input({ status: OrderStatusSchema })
		.resolve(async ({ status }, payload) => {
			return await resolveCommercial(payload, async (context) => [
				...(await context.services.ordersByStatus(status as OrderStatus)),
			])
		}),
	approveOrder: mutation(OrderSchema)
		.input({ id: id() })
		.resolve(async ({ id: orderId }, payload) => {
			return await resolveCommercial(payload, (context) => context.services.approveOrder(orderId))
		}),
	updateOrderAmount: mutation(OrderSchema)
		.input({ id: id(), amount: v.nonOptional(v.number()) })
		.resolve(async ({ id: orderId, amount }, payload) => {
			return await resolveCommercial(payload, (context) =>
				context.services.updateOrderAmount(orderId, amount),
			)
		}),
	setCustomerHealth: mutation(CustomerSchema)
		.input({ id: id(), score: v.nonOptional(v.number()) })
		.resolve(async ({ id: customerId, score }, payload) => {
			return await resolveCommercial(payload, (context) =>
				context.services.setCustomerHealth(customerId, score),
			)
		}),
})

async function resolveCommercial<T>(
	payload: { readonly context?: unknown } | undefined,
	fn: (context: CommercialContext) => Promise<T>,
): Promise<T> {
	const context = payload?.context as CommercialContext
	try {
		return await fn(context)
	} catch (error) {
		if (!isCommercialServiceError(error)) throw error
		throw new GraphQLError(error.message, {
			extensions: {
				code: error.code,
				status: error.status,
				http: { status: error.status },
				details: error.details,
			},
			originalError: error,
		})
	}
}

export function createSchema() {
	return ValibotWeaver.weave(commercialResolver)
}

export function createSchemaSDL(): string {
	return printSchema(createSchema())
}
