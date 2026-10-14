import type { InvoiceEvidence, InvoiceInput } from './contracts.ts'

/** Private DOM snapshot shared by both adapters; field interpretation stays in Node code. */
export interface PortalRecord {
	identity: {
		code: string[]
		number: string[]
		checkCode: string[]
		issueDate: string[]
		amount: string[]
	}
	marks: string[]
	evidence: InvoiceEvidence
}

/** Serialized by Playwright: keep this function self-contained, with no captured module values. */
export function readPortalRecords(elements: Element[], kind: InvoiceInput['kind']): PortalRecord[] {
	return elements.map((element) => {
		let truncated = false
		let remaining = 131072
		const take = (value: string, maximum = 4096) => {
			const length = Math.min(maximum, remaining)
			if (value.length > length) truncated = true
			const result = value.slice(0, length)
			remaining -= result.length
			return result
		}
		const limit = <T>(values: T[], maximum: number) => {
			if (values.length > maximum) truncated = true
			return values.slice(0, maximum)
		}
		const clone = element.cloneNode(true) as HTMLElement
		for (const node of clone.querySelectorAll('script, style, button, input, select, textarea'))
			node.remove()
		const text = take(clone.textContent?.trim() ?? '', 65536)
		const tables = limit([...clone.querySelectorAll('table')], 16).map((table) => ({
			rows: limit([...table.rows], 200).map((row) =>
				limit([...row.cells], 32).map((cell) => ({
					text: take(cell.textContent?.trim() ?? ''),
					header: cell.tagName === 'TH',
					rowSpan: cell.rowSpan,
					colSpan: cell.colSpan,
				})),
			),
		}))
		const fields: InvoiceEvidence['fields'] = []
		const field = (section: string, label: string, value: string) => {
			if (fields.length >= 128) {
				truncated = true
				return
			}
			fields.push({ section: take(section), label: take(label), value: take(value) })
		}
		for (const node of limit([...clone.querySelectorAll('p')], 128)) {
			const label = node.querySelector('label')
			if (!label) continue
			const section =
				kind === 'digital-tax'
					? (node
							.closest('.invoice-main__header > div')
							?.querySelector('.invoice-main__header--label')
							?.textContent?.trim() ?? '')
					: ''
			const name = label.textContent?.trim() ?? ''
			const value = node.cloneNode(true) as HTMLElement
			value.querySelector('label')?.remove()
			field(section, name, value.textContent?.trim() ?? '')
		}
		const selectors =
			kind === 'digital-tax'
				? [
						['票据名称', '.invoice-info-header__title'],
						['价税合计（大写）', '.invoice-main__table--upper'],
						['价税合计（小写）', '.invoice-main__table--price-position'],
						['备注', '.invoice-info-footer__remark--content'],
					]
				: [
						['票据代码', '#EInvoiceCode'],
						['票据号码', '#EInvoiceNumber'],
						['校验码', '#RandomNumber'],
						['开票日期', '#IssueDate'],
						['金额', 'td.nobd-l.td2 > span.font-val'],
					]
		for (const [label, selector] of selectors)
			for (const node of clone.querySelectorAll(selector))
				field('', label, node.textContent?.trim() ?? '')
		if (kind === 'digital-tax') {
			const totals = [...clone.querySelectorAll('.invoice-main__table--footer > span')]
			if (totals.length === 3 && totals[0].textContent?.trim() === '合计') {
				field('合计', '金额', totals[1].textContent?.trim() ?? '')
				field('合计', '税额', totals[2].textContent?.trim() ?? '')
			}
		}
		// Identity is read from the same original DOM, never from truncated evidence or filled form inputs.
		const values = (selector: string) =>
			[...element.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '')
		const headers = kind === 'digital-tax' ? values('.invoice-info-header__content > p') : []
		return {
			identity:
				kind === 'digital-tax'
					? {
							code: [],
							checkCode: [],
							number: headers.filter((value) => value.startsWith('发票号码')),
							issueDate: headers.filter((value) => value.startsWith('开票日期')),
							amount: values('.invoice-main__table--price-position'),
						}
					: {
							code: values('#EInvoiceCode'),
							number: values('#EInvoiceNumber'),
							checkCode: values('#RandomNumber'),
							issueDate: values('#IssueDate'),
							amount: values('td.nobd-l.td2 > span.font-val'),
						},
			marks:
				kind === 'digital-tax'
					? [...element.querySelectorAll('img')]
							.filter(
								(node) =>
									node.getClientRects().length > 0 &&
									getComputedStyle(node).visibility !== 'hidden',
							)
							.map((node) => node.getAttribute('src') ?? '')
							.filter((src) => src.startsWith('/fpcygzfw/assets_res/img/'))
					: [],
			evidence: { source: 'official-portal', fields, tables, text, truncated },
		}
	})
}
