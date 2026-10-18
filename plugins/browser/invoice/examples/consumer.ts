import { BasePlugin, Plugin } from '@pluxel/core'
import { InvoicePlugin, type InvoiceImage, type InvoiceOptions } from '@pluxel/plugin-invoice'

@Plugin()
export class InvoiceConsumer extends BasePlugin {
	constructor(private readonly invoices: InvoicePlugin) {
		super()
	}

	async check(image: InvoiceImage, options: InvoiceOptions = {}) {
		const result = await this.invoices.verifyImage(image, options)
		if (result.status === 'needs_review') return { state: 'review' as const, result }
		switch (result.verification.status) {
			case 'matched': {
				const { details } = result.verification
				// Business fields need no Chinese-label lookup. Preserve the complete result for review.
				return {
					state: 'observed' as const,
					issuerName:
						details.kind === 'digital-tax'
							? (details.seller?.name ?? null)
							: (details.payee?.name ?? null),
					result,
				}
			}
			case 'action_required':
				return { state: 'needs-human' as const, result }
			case 'unconfirmed':
				return { state: 'review' as const, result }
		}
	}
}
