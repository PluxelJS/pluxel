import type { Page } from 'playwright-core'

/** The five fields in the national fiscal ticket portal's desktop form. */
export interface FiscalTicketInput {
	/** Exactly eight digits, preserving leading zeroes. */
	code: string
	/** Exactly ten digits, preserving leading zeroes. */
	number: string
	/** Six ASCII letters or digits; distinct from the interactive security challenge. */
	checkCode: string
	/** Decimal yuan, at most two decimal places. Negative credit tickets are allowed. */
	amount: string
	/** Valid calendar date in YYYY-MM-DD format. */
	issueDate: string
}

export interface FiscalTicketVerifyOptions {
	/** Abort closes this operation's isolated context. It does not undo a submitted query. */
	signal?: AbortSignal
	/**
	 * Called at most once, when the portal displays its security challenge.
	 * The page is borrowed until this callback settles or signal aborts. Complete the
	 * challenge through the site's normal UI; do not close or retain the page.
	 * Honor signal for any external IO: cancellation cannot stop arbitrary callback code.
	 */
	onChallenge?: (challenge: { page: Page; signal: AbortSignal }) => Promise<void>
}

/** A DOM observation, not an independent authenticity or cryptographic attestation. */
export type FiscalTicketResult =
	| { status: 'matched'; ticket: FiscalTicketInput; checkedAt: string }
	| { status: 'action_required'; challenge: 'security_verification' }
	| {
			status: 'unconfirmed'
			reason: 'unsupported_result' | 'identity_mismatch' | 'site_message'
			/** Bounded website text; may contain ticket information. Treat as untrusted text. */
			message?: string
	  }

/** Execution failure. Playwright, callback and lifecycle exceptions retain their original types. */
export class FiscalTicketError extends Error {
	constructor(
		readonly code: 'BUSY' | 'NOT_RUNNING' | 'TIMEOUT',
		message: string,
	) {
		super(message)
		this.name = 'FiscalTicketError'
	}
}
