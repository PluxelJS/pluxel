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

export type InvoiceInput =
	| { kind: 'fiscal'; ticket: FiscalTicketInput }
	| {
			kind: 'digital-tax'
			/** Twenty digits, including all zeroes. */
			number: string
			issueDate: string
			/** The current portal requests tax-inclusive total for twenty-digit invoices. */
			totalIncludingTax: string
	  }

export interface InvoiceImage {
	bytes: Uint8Array
	mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface InvoiceOptions {
	/** Tax text CAPTCHA fallback, at most once. Return characters or null to decline; no browser API needed. */
	onCaptcha?: (challenge: {
		image: InvoiceImage
		instruction: string
		signal: AbortSignal
	}) => Promise<string | null>
	/** Abort this operation and close its context; submitted queries cannot be undone. */
	signal?: AbortSignal
	/** Borrowed page, at most once. Complete the normal challenge; do not close or retain it. Honor signal for external IO. */
	onChallenge?: (challenge: { page: Page; signal: AbortSignal }) => Promise<void>
}
export type InvoiceExtraction =
	| { status: 'extracted'; input: InvoiceInput; details: InvoiceDetails }
	| {
			status: 'needs_review'
			reason: 'unsupported_document' | 'invalid_fields'
			fields: string[]
			/** Bounded model transcription for correction, never silently repaired or submitted. */
			candidate: Record<string, string | null>
	  }

/** Observed portal detail, not model transcription or a claim of complete tax records. */
export interface InvoiceEvidence {
	source: 'official-portal'
	/** Original labels and values; duplicate labels remain distinguishable by section/order. */
	fields: { section: string; label: string; value: string }[]
	/** Original cells, including headers and merged-cell geometry. Values remain strings. */
	tables: { rows: { text: string; header: boolean; rowSpan: number; colSpan: number }[][] }[]
	/** Detail-container text, excluding scripts and controls. Fiscal uses its populated source template. */
	text: string
	/** True if any collection/string limit was reached; false does not certify portal completeness. */
	truncated: boolean
}

/** Null means unavailable/unparseable, not an empty string or zero. Identifiers remain strings. */
export interface InvoiceParty {
	name: string | null
	taxId: string | null
}

/** Decimal strings preserve precision. Tax rates retain portal notation such as 13% or 免税. */
export interface InvoiceLineItem {
	name: string | null
	specification: string | null
	unit: string | null
	quantity: string | null
	unitPrice: string | null
	amount: string | null
	taxRate: string | null
	taxAmount: string | null
}

/** Business data, independent of model/portal provenance. Never combines the two sources. */
export type InvoiceDetails = {
	title: string | null
	/** Null means no unambiguous supported item table; [] means an observed empty table. */
	items: InvoiceLineItem[] | null
	remarks: string | null
	issuedBy: string | null
} & (
	| {
			kind: 'digital-tax'
			number: string
			issueDate: string
			buyer: InvoiceParty | null
			seller: InvoiceParty | null
			amounts: {
				totalExcludingTax: string | null
				taxAmount: string | null
				totalIncludingTax: string
				totalIncludingTaxUppercase: string | null
			}
	  }
	| {
			kind: 'fiscal'
			code: string
			number: string
			checkCode: string
			issueDate: string
			payer: InvoiceParty | null
			payee: InvoiceParty | null
			amount: string
	  }
)

/** Supplementary detail problems do not change a successful identity comparison. */
export interface InvoiceDetailIssue {
	/** Dot path relative to the matched verification result, e.g. details.buyer.name or evidence. */
	path: string
	code:
		| 'ambiguous_field'
		| 'invalid_value'
		| 'unsupported_table'
		| 'inconsistent_totals'
		| 'truncated_evidence'
}

export type InvoiceVerification =
	| {
			status: 'matched'
			checkedAt: string
			details: InvoiceDetails
			evidence: InvoiceEvidence
			issues: InvoiceDetailIssue[]
			/** Official marker observation only. Currently detects tax full reversal; not_observed is not normal status. */
			redLetterStatus: 'fully_reversed' | 'not_observed'
	  }
	| { status: 'action_required'; challenge: 'security_verification' }
	| {
			status: 'unconfirmed'
			reason: 'unsupported_result' | 'identity_mismatch' | 'site_message'
			message?: string
	  }

export type InvoiceImageResult =
	| Extract<InvoiceExtraction, { status: 'needs_review' }>
	| {
			status: 'completed'
			/** Model-only transcription and the query projected from it; never overwritten by portal data. */
			extraction: Extract<InvoiceExtraction, { status: 'extracted' }>
			verification: InvoiceVerification
	  }

export class InvoiceError extends Error {
	override readonly name = 'InvoiceError'
	constructor(
		readonly code:
			| 'BUSY'
			| 'NOT_RUNNING'
			| 'TIMEOUT'
			| 'VLM_NOT_CONFIGURED'
			| 'VLM_HTTP'
			| 'VLM_RESPONSE',
		message: string,
		readonly httpStatus?: number,
	) {
		super(message)
	}
}
