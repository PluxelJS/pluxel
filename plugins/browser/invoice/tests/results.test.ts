import { expect, it } from 'vitest'
import { readTaxResult } from '../src/tax-portal.ts'
import type { PortalRecord } from '../src/portal-snapshot.ts'
import { invoice } from './setup.ts'

const record: PortalRecord = {
	evidence: { source: 'official-portal', fields: [], tables: [], text: '', truncated: false },
	identity: {
		code: [],
		checkCode: [],
		number: ['发票号码：12345678901234567890'],
		issueDate: ['开票日期：2026年07月17日'],
		amount: ['（小写）¥113.00'],
	},
	marks: [],
}
const identity = (change: Partial<PortalRecord['identity']>): PortalRecord => ({
	...record,
	identity: { ...record.identity, ...change },
})

it('requires one complete matching record, never filled inputs, duplicate identity fields or notices', () => {
	expect(readTaxResult([], invoice)).toBeUndefined()
	for (const records of [
		[identity({ number: [] })],
		[record, record],
		[identity({ amount: ['（小写）¥113.001'] })],
		[identity({ amount: ['（小写）¥113,000.00'] })],
		[identity({ number: [...record.identity.number, ...record.identity.number] })],
	])
		expect(readTaxResult(records, invoice)).toEqual({
			status: 'unconfirmed',
			reason: 'unsupported_result',
		})
	for (const changed of [
		identity({ amount: ['（小写）¥114.00'] }),
		identity({ issueDate: ['开票日期：2026年07月18日'] }),
	])
		expect(readTaxResult([changed], invoice)).toEqual({
			status: 'unconfirmed',
			reason: 'identity_mismatch',
		})
	expect(readTaxResult([record], invoice)).toMatchObject({
		status: 'matched',
		details: { kind: 'digital-tax', number: invoice.number },
		redLetterStatus: 'not_observed',
	})
})
