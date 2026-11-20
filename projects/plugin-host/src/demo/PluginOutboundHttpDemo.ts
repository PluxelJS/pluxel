import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { ElysiaApp } from '@pluxel/services/elysia'
import * as v from 'valibot'
import type { Wretch } from 'wretch'
import { retry } from 'wretch/middlewares'

const CustomerSchema = v.object({ id: v.string(), name: v.string() })
type Customer = v.InferOutput<typeof CustomerSchema>

export class CustomerNotFound extends TaggedError('CustomerNotFound')<{
	id: string
	message: string
}> {}

const CustomerConfig = v.object({
	baseUrl: v.pipe(v.string(), v.url()),
	retryAttempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)), 0),
})

@Plugin()
export class OutboundCustomerPlugin extends BasePlugin {
	private readonly config = this.configs.use(CustomerConfig)
	private api!: Wretch

	protected override init(): void {
		const api = this.ctx.wretch
			.url(this.config.baseUrl, true)
			.accept('application/json')
			.headers({ 'X-Pluxel-Client': 'OutboundCustomerPlugin' })
		const { retryAttempts } = this.config
		this.api =
			retryAttempts === 0
				? api
				: api.middlewares([retry({ maxAttempts: retryAttempts, retryOnNetworkError: true })])
	}

	inspect(): Promise<unknown> {
		return this.api.get('/inspect-me').json<unknown>()
	}

	findCustomer(id: string): Promise<Result<Customer, CustomerNotFound>> {
		return this.api
			.get(`/customers/${encodeURIComponent(id)}`)
			.notFound(() =>
				Result.err(new CustomerNotFound({ id, message: `Customer ${id} was not found` })),
			)
			.json((body) => Result.ok(v.parse(CustomerSchema, body)))
	}
}

@Plugin()
export class CustomerHttpConsumer extends BasePlugin {
	constructor(private readonly customers: OutboundCustomerPlugin) {
		super()
	}

	protected override init(): void {
		this.ctx
			.service(ElysiaApp)
			.get('/wretch-example/customers/:id', ({ params }) => this.customerDto(params.id))
	}

	private async customerDto(id: string): Promise<Response> {
		const result = await this.customers.findCustomer(id)
		if (Result.isError(result)) {
			return Response.json(
				{ ok: false, code: 'customer_not_found', message: result.error.message },
				{ status: 404 },
			)
		}
		return Response.json({ ok: true, customer: result.value })
	}
}
