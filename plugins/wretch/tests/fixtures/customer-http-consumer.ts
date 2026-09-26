import { BasePlugin, Plugin } from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import { ElysiaApp } from '@pluxel/services/elysia'
import { WretchExamplePlugin } from './wretch-example.ts'

/** A separate Plugin consumes the local Result and publishes only plain HTTP data. */
@Plugin()
export class CustomerHttpConsumer extends BasePlugin {
	constructor(private readonly customers: WretchExamplePlugin) {
		super()
	}

	override init(): void {
		this.ctx
			.require(ElysiaApp)
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
