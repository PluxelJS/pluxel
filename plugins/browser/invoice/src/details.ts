import * as v from 'valibot'
import type {
	InvoiceDetails,
	InvoiceDetailIssue,
	InvoiceEvidence,
	InvoiceInput,
	InvoiceLineItem,
	InvoiceParty,
} from './contracts.ts'
import { cents, money } from './values.ts'

/** Start from validated identity, with no guessed supplementary business data. */
export function emptyDetails(input: InvoiceInput): InvoiceDetails {
	const common: Pick<InvoiceDetails, 'title' | 'items' | 'remarks' | 'issuedBy'> = {
		title: null,
		items: null,
		remarks: null,
		issuedBy: null,
	}
	return input.kind === 'fiscal'
		? { ...common, kind: 'fiscal', ...input.ticket, payer: null, payee: null }
		: {
				...common,
				kind: 'digital-tax',
				number: input.number,
				issueDate: input.issueDate,
				buyer: null,
				seller: null,
				amounts: {
					totalExcludingTax: null,
					taxAmount: null,
					totalIncludingTax: input.totalIncludingTax,
					totalIncludingTaxUppercase: null,
				},
			}
}

const labelKey = (value: string) => value.replaceAll(/[\s：:]/g, '')
const columns: Record<string, keyof InvoiceLineItem> = {
	项目名称: 'name',
	货物或应税劳务服务名称: 'name',
	收费项目: 'name',
	规格型号: 'specification',
	单位: 'unit',
	数量: 'quantity',
	单价: 'unitPrice',
	金额: 'amount',
	税率: 'taxRate',
	'税率/征收率': 'taxRate',
	税额: 'taxAmount',
}

const columnKey = (text: string): keyof InvoiceLineItem | undefined => {
	const key = labelKey(text)
	return Object.hasOwn(columns, key) ? columns[key] : undefined
}

/** Normalize only unambiguous observed fields. Evidence remains the authoritative original text. */
export function normalizeDetails(
	input: InvoiceInput,
	evidence: InvoiceEvidence,
): {
	details: InvoiceDetails
	issues: InvoiceDetailIssue[]
} {
	const details = emptyDetails(input)
	const issues: InvoiceDetailIssue[] = []
	const issue = (path: string, code: InvoiceDetailIssue['code']) =>
		issues.push({ path: `details.${path}`, code })
	// A sliced decimal/name can still look valid. Never promote truncated evidence into business fields.
	if (evidence.truncated) {
		issues.push({ path: 'evidence', code: 'truncated_evidence' })
		return { details, issues }
	}
	const field = (path: string, section: string, labels: string[]): string | null => {
		const values = evidence.fields.filter(
			(entry) =>
				labelKey(entry.section) === labelKey(section) &&
				labels.some((label) => labelKey(entry.label) === labelKey(label)),
		)
		if (values.length > 1) {
			issue(path, 'ambiguous_field')
			return null
		}
		return values[0]?.value ?? null
	}
	const decimal = (value: string | null, path: string, currency = false): string | null => {
		if (value === null || value === '') return null
		const normalized = currency ? value.replace(/^[¥￥]\s*/, '') : value
		const valid = currency
			? v.safeParse(money, normalized).success
			: /^-?\d{1,16}(?:\.\d{1,12})?$/.test(normalized)
		if (valid) return normalized
		issue(path, 'invalid_value')
		return null
	}
	const party = (path: string, section: string): InvoiceParty | null => {
		const name = field(`${path}.name`, section, ['名称'])
		const taxId = field(`${path}.taxId`, section, [
			'统一社会信用代码/纳税人识别号',
			'纳税人识别号',
			'统一社会信用代码',
		])
		return name === null && taxId === null ? null : { name, taxId }
	}
	details.title = field('title', '', ['票据名称'])
	details.remarks = field('remarks', '', ['备注'])
	details.issuedBy = field('issuedBy', '', ['开票人'])
	if (details.kind === 'digital-tax') {
		details.buyer = party('buyer', '购买方信息')
		details.seller = party('seller', '销售方信息')
		details.amounts.totalExcludingTax = decimal(
			field('amounts.totalExcludingTax', '合计', ['金额']),
			'amounts.totalExcludingTax',
			true,
		)
		details.amounts.taxAmount = decimal(
			field('amounts.taxAmount', '合计', ['税额']),
			'amounts.taxAmount',
			true,
		)
		details.amounts.totalIncludingTaxUppercase = field('amounts.totalIncludingTaxUppercase', '', [
			'价税合计（大写）',
		])
		const { totalExcludingTax, taxAmount, totalIncludingTax } = details.amounts
		if (
			totalExcludingTax !== null &&
			taxAmount !== null &&
			cents(totalExcludingTax) + cents(taxAmount) !== cents(totalIncludingTax)
		)
			issue('amounts', 'inconsistent_totals')
	} else {
		const payer = field('payer.name', '', ['交款人', '交款单位'])
		const payee = field('payee.name', '', ['收款单位'])
		details.payer = payer === null ? null : { name: payer, taxId: null }
		details.payee = payee === null ? null : { name: payee, taxId: null }
	}
	const itemTables = evidence.tables.filter((table) => {
		const header = table.rows[0]
		return (
			header?.some((cell) => columnKey(cell.text) === 'name') &&
			header.some((cell) => columnKey(cell.text) === 'amount')
		)
	})
	if (itemTables.length > 1) issue('items', 'ambiguous_field')
	else if (itemTables.length === 1) {
		const [header, ...rows] = itemTables[0].rows
		const keys = header.map((cell) => columnKey(cell.text))
		const known = keys.filter((key) => key !== undefined)
		if (
			new Set(known).size !== known.length ||
			header.some((cell) => !cell.header || cell.rowSpan !== 1 || cell.colSpan !== 1) ||
			rows.some(
				(row) =>
					row.length !== header.length ||
					row.some((cell) => cell.rowSpan !== 1 || cell.colSpan !== 1 || cell.header),
			)
		) {
			issue('items', 'unsupported_table')
		} else {
			details.items = rows.map((row, index) => {
				const item: InvoiceLineItem = {
					name: null,
					specification: null,
					unit: null,
					quantity: null,
					unitPrice: null,
					amount: null,
					taxRate: null,
					taxAmount: null,
				}
				for (const [column, key] of keys.entries()) {
					if (!key) continue
					const value = row[column].text
					item[key] = ['amount', 'taxAmount', 'unitPrice', 'quantity'].includes(key)
						? decimal(value, `items.${index}.${key}`, key === 'amount' || key === 'taxAmount')
						: value
				}
				return item
			})
		}
	} else if (evidence.tables.length > 0) issue('items', 'unsupported_table')
	return { details, issues }
}
