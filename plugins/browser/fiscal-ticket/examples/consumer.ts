import { BasePlugin, Plugin } from '@pluxel/core'
import {
	FiscalTicketPlugin,
	type FiscalTicketInput,
	type FiscalTicketVerifyOptions,
} from '@pluxel/fiscal-ticket'

/** Include this Plugin and both browser plugins in your application's explicit catalog. */
@Plugin({ displayName: 'Fiscal ticket consumer example' })
export class FiscalTicketConsumer extends BasePlugin {
	constructor(private readonly fiscalTickets: FiscalTicketPlugin) {
		super()
	}

	/** The application supplies the ticket and, optionally, a trusted human-interaction callback. */
	async check(input: FiscalTicketInput, options: FiscalTicketVerifyOptions = {}) {
		const result = await this.fiscalTickets.verify(input, options)
		switch (result.status) {
			case 'matched':
				return { state: 'observed' as const, checkedAt: result.checkedAt, ticket: result.ticket }
			case 'action_required':
				// The operation's page is already closed. Start a new call with onChallenge.
				return { state: 'needs-human' as const, challenge: result.challenge }
			case 'unconfirmed':
				return { state: 'review' as const, reason: result.reason, message: result.message }
		}
		// SDK/callback errors and cancellation reject; the application's caller owns recovery.
	}
}
