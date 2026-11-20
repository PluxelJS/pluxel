import { RuntimeLogStore } from '@pluxel/core/logging'
import { expect, it } from 'vitest'

const selected = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/selected' },
		exportName: 'Plugin',
	},
	variant: 'default',
} as const

it('pages a filtered log through the retention window using the scanned stream cursor', () => {
	const store = new RuntimeLogStore({ streamId: 'test', windowLines: 1_400, epoch: 1 })
	store.append(
		Array.from({ length: 2_000 }, (_, index) => {
			const seq = index + 1
			return {
				ts: 1_700_000_000_000 + seq,
				level: 'info' as const,
				category: ['pluxel'],
				msg: `record ${seq}`,
				plugin: [1_701, 1_903, 2_000].includes(seq) ? selected : undefined,
			}
		}),
	)

	expect(store.range({ epoch: 1, fromSeq: '600', limit: 2 })).toMatchObject({
		ok: false,
		code: 'from_too_old',
		headSeq: '601',
		tailSeq: '2000',
	})
	const first = store.range({
		epoch: 1,
		fromSeq: '601',
		limit: 2,
		filter: { plugin: selected },
	})
	if (!first.ok) throw new Error('Expected the retained log to be readable')
	expect(first.lines.map((line) => line.seq)).toEqual(['1701', '1903'])
	expect(first.nextSeq).toBe('1904')

	const second = store.range({
		epoch: 1,
		fromSeq: first.nextSeq,
		limit: 2,
		filter: { plugin: selected },
	})
	expect(second).toMatchObject({ ok: true, lines: [{ seq: '2000' }], nextSeq: '2001' })
	expect(store.range({ epoch: 1, fromSeq: '2001', limit: 2 })).toMatchObject({
		ok: true,
		lines: [],
		nextSeq: '2001',
	})
	expect(store.tailWindow(2).map((line) => line.seq)).toEqual(['1999', '2000'])
})
