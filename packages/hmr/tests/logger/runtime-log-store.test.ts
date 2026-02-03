import { describe, expect, it } from 'vitest'
import { RuntimeLogStore } from '../../src/logger/store'

function lineInput(i: number, extra?: Partial<any>) {
	return {
		ts: 1700000000000 + i,
		level: 'info' as const,
		category: ['pluxel', 'hmr'],
		msg: `line-${i}`,
		...extra,
	}
}

describe('RuntimeLogStore', () => {
	it('keeps a bounded retention window with monotonic seq', () => {
		const store = new RuntimeLogStore({ streamId: 't', windowLines: 5, epoch: 1 })
		store.append(Array.from({ length: 8 }, (_, i) => lineInput(i + 1)))

		const meta = store.meta()
		expect(meta.epoch).toBe(1)
		expect(meta.count).toBe(5)
		expect(meta.headSeq).toBe('4')
		expect(meta.tailSeq).toBe('8')
		expect(meta.nextSeq).toBe('9')
	})

	it('ranges correctly and advances nextSeq by scanned offset', () => {
		const store = new RuntimeLogStore({ streamId: 't', windowLines: 5, epoch: 1 })
		store.append(Array.from({ length: 8 }, (_, i) => lineInput(i + 1)))

		const out = store.range({ epoch: 1, fromSeq: '4', limit: 2 })
		expect(out.ok).toBe(true)
		if (!out.ok) return
		expect(out.lines.map((l) => l.seq)).toEqual(['4', '5'])
		expect(out.nextSeq).toBe('6')

		const tailPlusOne = store.range({ epoch: 1, fromSeq: '9', limit: 10 })
		expect(tailPlusOne.ok).toBe(true)
		if (!tailPlusOne.ok) return
		expect(tailPlusOne.lines.length).toBe(0)
		expect(tailPlusOne.nextSeq).toBe('9')
	})

	it('filters without breaking cursor semantics', () => {
		const store = new RuntimeLogStore({ streamId: 't', windowLines: 50, epoch: 1 })
		store.append([
			lineInput(1, { pluginId: 'a' }),
			lineInput(2, { pluginId: 'b' }),
			lineInput(3, { pluginId: 'a' }),
			lineInput(4, { pluginId: 'b' }),
			lineInput(5, { pluginId: 'a' }),
			lineInput(6, { pluginId: 'b' }),
		])

		const out = store.range({ epoch: 1, fromSeq: '1', limit: 2, filter: { pluginId: 'a' } })
		expect(out.ok).toBe(true)
		if (!out.ok) return
		expect(out.lines.map((l) => l.seq)).toEqual(['1', '3'])
		// scanned 1..3 and stopped after the 2nd match
		expect(out.nextSeq).toBe('4')
	})

	it('tailWindow returns the newest N lines', () => {
		const store = new RuntimeLogStore({ streamId: 't', windowLines: 20, epoch: 1 })
		store.append(Array.from({ length: 6 }, (_, i) => lineInput(i + 1)))
		const tail = store.tailWindow(3)
		expect(tail.map((l) => l.seq)).toEqual(['4', '5', '6'])
	})

	it('can skip whole chunks when filters cannot match', () => {
		const store = new RuntimeLogStore({ streamId: 't', windowLines: 2000, epoch: 1 })
		const a = Array.from({ length: 1100 }, (_, i) => lineInput(i + 1, { pluginId: 'a' }))
		const x = Array.from({ length: 10 }, (_, i) => lineInput(1100 + i + 1, { pluginId: 'x' }))
		store.append(a)
		store.append(x)

		const out = store.range({ epoch: 1, fromSeq: '1', limit: 1, filter: { pluginId: 'x' } })
		expect(out.ok).toBe(true)
		if (!out.ok) return
		expect(out.lines.map((l) => l.seq)).toEqual(['1101'])
		expect(out.nextSeq).toBe('1102')
	})
})

