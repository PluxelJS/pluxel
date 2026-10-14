import { expect, it } from 'vitest'
import type { InvoiceEvidence } from '../src/contracts.ts'
import { normalizeDetails } from '../src/details.ts'
import { invoice } from './setup.ts'

function evidence(): InvoiceEvidence {
	const cell = (text: string, header = false) => ({ text, header, rowSpan: 1, colSpan: 1 })
	return {
		source: 'official-portal',
		text: 'original',
		truncated: false,
		fields: [
			{ section: '购买方信息', label: '名称：', value: '测试购买方' },
			{ section: '购买方信息', label: '纳税人识别号：', value: '001234567890123456' },
			{ section: '销售方信息', label: '名称：', value: '测试销售方' },
			{ section: '合计', label: '金额', value: '￥100.00' },
			{ section: '合计', label: '税额', value: '¥13.00' },
			{ section: '', label: '备注', value: '' },
		],
		tables: [
			{
				rows: [
					[
						'项目名称',
						'规格型号',
						'单 位',
						'数 量',
						'单价',
						'金额',
						'税率/征收率',
						'税额',
						'未知附加列',
					].map((text) => cell(text, true)),
					[
						'测试服务',
						'',
						'次',
						'1',
						'100.000000000001',
						'100.00',
						'13%',
						'13.00',
						'保留在证据',
					].map((text) => cell(text)),
				],
			},
		],
	}
}

it('provides typed business fields without losing string precision or source evidence', () => {
	const source = evidence()
	const before = structuredClone(source)
	const result = normalizeDetails(invoice, source)
	expect(source).toEqual(before)
	expect(result.issues).toEqual([])
	expect(result.details).toMatchObject({
		kind: 'digital-tax',
		buyer: { name: '测试购买方', taxId: '001234567890123456' },
		seller: { name: '测试销售方', taxId: null },
		remarks: '',
		issuedBy: null,
		amounts: { totalExcludingTax: '100.00', taxAmount: '13.00', totalIncludingTax: '113.00' },
		items: [
			{
				name: '测试服务',
				specification: '',
				unit: '次',
				quantity: '1',
				unitPrice: '100.000000000001',
				amount: '100.00',
				taxRate: '13%',
				taxAmount: '13.00',
			},
		],
	})
})

it('does not pick an arbitrary value for duplicate party labels', () => {
	const source = evidence()
	source.fields.push({ ...source.fields[0], value: '另一个购买方' })
	const result = normalizeDetails(invoice, source)
	expect(result.details).toMatchObject({ buyer: { name: null, taxId: '001234567890123456' } })
	expect(result.issues).toContainEqual({ path: 'details.buyer.name', code: 'ambiguous_field' })
})

it('keeps an invalid amount in evidence and does not convert it into a number', () => {
	const source = evidence()
	source.fields[3].value = '￥1,000.00'
	const result = normalizeDetails(invoice, source)
	expect(result.details).toMatchObject({ amounts: { totalExcludingTax: null } })
	expect(result.issues).toContainEqual({
		path: 'details.amounts.totalExcludingTax',
		code: 'invalid_value',
	})
	expect(source.fields[3].value).toBe('￥1,000.00')
})

it('reports contradictory official totals without silently repairing them', () => {
	const source = evidence()
	source.fields[4].value = '12.00'
	const result = normalizeDetails(invoice, source)
	expect(result.details).toMatchObject({
		amounts: { totalExcludingTax: '100.00', taxAmount: '12.00', totalIncludingTax: '113.00' },
	})
	expect(result.issues).toContainEqual({ path: 'details.amounts', code: 'inconsistent_totals' })
})

it('distinguishes absent item data from an observed empty table', () => {
	const source = evidence()
	source.tables[0].rows = [source.tables[0].rows[0]]
	expect(normalizeDetails(invoice, source).details.items).toEqual([])
	source.tables = []
	expect(normalizeDetails(invoice, source).details.items).toBeNull()
})

it.each(['merged', 'duplicate-column', 'short-row', 'repeated-header', 'duplicate-table'])(
	'never shifts or silently drops ambiguous item rows: %s',
	(scenario) => {
		const source = evidence()
		const rows = source.tables[0].rows
		if (scenario === 'merged') rows[1][0].colSpan = 2
		if (scenario === 'duplicate-column') rows[0][1].text = '项目名称'
		if (scenario === 'short-row') rows[1].pop()
		if (scenario === 'repeated-header') rows.push(rows[0])
		if (scenario === 'duplicate-table') source.tables.push(structuredClone(source.tables[0]))
		const result = normalizeDetails(invoice, source)
		expect(result.details.items).toBeNull()
		expect(result.issues).toContainEqual({
			path: 'details.items',
			code: scenario === 'duplicate-table' ? 'ambiguous_field' : 'unsupported_table',
		})
	},
)

it('retains exempt tax text and treats masked amounts as unavailable, never zero', () => {
	const source = evidence()
	const row = source.tables[0].rows[1]
	row[3].text = '0'
	row[6].text = '免税'
	row[7].text = '***'
	const result = normalizeDetails(invoice, source)
	expect(result.details.items?.[0]).toMatchObject({
		quantity: '0',
		taxRate: '免税',
		taxAmount: null,
	})
	expect(result.issues).toContainEqual({ path: 'details.items.0.taxAmount', code: 'invalid_value' })
})

it('never presents truncated evidence as complete party/amount/item data', () => {
	const source = evidence()
	source.truncated = true
	const result = normalizeDetails(invoice, source)
	expect(result.details).toMatchObject({
		buyer: null,
		seller: null,
		items: null,
		amounts: { totalExcludingTax: null, totalIncludingTax: '113.00' },
	})
	expect(result.issues).toEqual([{ path: 'evidence', code: 'truncated_evidence' }])
})

it('treats arbitrary and prototype-like table headers as unmapped evidence', () => {
	const source = evidence()
	source.tables[0].rows[0][8].text = '__proto__'
	const result = normalizeDetails(invoice, source)
	expect(result.details.items?.[0]).toMatchObject({ name: '测试服务', amount: '100.00' })
	expect(Object.keys(result.details.items![0])).toHaveLength(8)
})

it('maps reordered item columns by their headers rather than positional assumptions', () => {
	const source = evidence()
	for (const row of source.tables[0].rows) row.reverse()
	const result = normalizeDetails(invoice, source)
	expect(result.details.items?.[0]).toMatchObject({
		name: '测试服务',
		amount: '100.00',
		taxAmount: '13.00',
		quantity: '1',
	})
	expect(result.issues).toEqual([])
})
