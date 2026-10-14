import * as v from 'valibot'
import { cents, date, money } from './values.ts'
import { emptyDetails } from './details.ts'
import type { InvoiceExtraction, InvoiceImage, InvoiceInput } from './contracts.ts'

const digits = (length: number) => v.pipe(v.string(), v.regex(new RegExp(`^\\d{${length}}$`)))
const fiscal = v.object({
	code: digits(8),
	number: digits(10),
	checkCode: v.pipe(v.string(), v.regex(/^[A-Za-z0-9]{6}$/)),
	amount: money,
	issueDate: date,
})
export const InputSchema = v.variant('kind', [
	v.object({ kind: v.literal('fiscal'), ticket: fiscal }),
	v.object({
		kind: v.literal('digital-tax'),
		number: digits(20),
		issueDate: date,
		totalIncludingTax: money,
	}),
])

export function validateInput(value: InvoiceInput): InvoiceInput {
	const result = v.safeParse(InputSchema, value)
	if (!result.success)
		throw new TypeError('Invoice input has invalid kind, number, date or amount fields')
	return result.output
}

export function copyImage(image: InvoiceImage): InvoiceImage {
	if (
		!image ||
		!(image.bytes instanceof Uint8Array) ||
		!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)
	)
		throw new TypeError('Invoice image must contain bytes and a supported MIME type')
	if (image.bytes.byteLength === 0 || image.bytes.byteLength > 10 * 1024 * 1024)
		throw new TypeError('Invoice image must contain 1 to 10485760 bytes')
	const bytes = Uint8Array.from(image.bytes)
	const valid =
		image.mimeType === 'image/jpeg'
			? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
			: image.mimeType === 'image/png'
				? Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
				: Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
					Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP'
	if (!valid) throw new TypeError('Invoice image MIME type does not match its signature')
	return { bytes, mimeType: image.mimeType }
}

/** Recognition is untrusted input. No zero-padding, guessing, trimming or currency repair. */
export function extraction(candidate: Record<string, string | null>): InvoiceExtraction {
	const kind = candidate.kind
	if (kind !== 'fiscal' && kind !== 'digital-tax')
		return { status: 'needs_review', reason: 'unsupported_document', fields: ['kind'], candidate }
	const value =
		kind === 'fiscal'
			? {
					kind,
					ticket: {
						code: candidate.code,
						number: candidate.number,
						checkCode: candidate.checkCode,
						amount: candidate.amount,
						issueDate: candidate.issueDate,
					},
				}
			: {
					kind,
					number: candidate.number,
					issueDate: candidate.issueDate,
					totalIncludingTax: candidate.totalIncludingTax,
				}
	const parsed = v.safeParse(InputSchema, value)
	const fields = parsed.success
		? []
		: parsed.issues.map((issue) => issue.path?.map((part) => part.key).join('.') ?? 'input')
	if (kind === 'digital-tax') {
		for (const key of ['totalExcludingTax', 'taxAmount', 'totalIncludingTax'] as const)
			if (!v.safeParse(money, candidate[key]).success) fields.push(key)
		if (
			fields.length === 0 &&
			cents(candidate.totalExcludingTax!) + cents(candidate.taxAmount!) !==
				cents(candidate.totalIncludingTax!)
		)
			fields.push('amount_totals')
	}
	if (!parsed.success || fields.length > 0)
		return {
			status: 'needs_review',
			reason: 'invalid_fields',
			fields: [...new Set(fields)],
			candidate,
		}
	const details = emptyDetails(parsed.output)
	if (details.kind === 'digital-tax') {
		details.amounts.totalExcludingTax = candidate.totalExcludingTax!
		details.amounts.taxAmount = candidate.taxAmount!
	}
	return { status: 'extracted', input: parsed.output, details }
}
