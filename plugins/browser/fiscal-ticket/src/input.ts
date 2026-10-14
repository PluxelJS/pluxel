import type { FiscalTicketInput } from './contracts.ts'

/** Copy validated inputs before the first await; caller mutation cannot change a query. */
export function validateInput(input: FiscalTicketInput): FiscalTicketInput {
	if (!input || typeof input !== 'object')
		throw new TypeError('Fiscal ticket input must be an object')
	const { code, number, checkCode, amount, issueDate } = input
	const fields = [
		['code', code, /^\d{8}$/, 'eight digits'],
		['number', number, /^\d{10}$/, 'ten digits'],
		['checkCode', checkCode, /^[A-Za-z0-9]{6}$/, 'six ASCII letters or digits'],
		[
			'amount',
			amount,
			/^-?\d{1,16}(?:\.\d{1,2})?$/,
			'a decimal amount with at most two decimal places and sixteen integer digits',
		],
		['issueDate', issueDate, /^\d{4}-\d{2}-\d{2}$/, 'a calendar date in YYYY-MM-DD format'],
	] as const
	for (const [field, value, pattern, expected] of fields) {
		if (typeof value !== 'string' || !pattern.test(value)) {
			throw new TypeError(`Fiscal ticket ${field} must be ${expected}`)
		}
	}
	const date = new Date(`${issueDate}T00:00:00.000Z`)
	if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== issueDate) {
		throw new TypeError('Fiscal ticket issueDate must be a valid calendar date')
	}
	return { code, number, checkCode, amount, issueDate }
}
