import { describe, expect, it, vi } from 'vitest'
import type { RuntimeLogLine } from '../src/runtime'
import { createLogStreamStore } from '../src/app/log_viewer/logStreamStore'

function line(seq: number): RuntimeLogLine {
	return {
		streamId: 'default',
		epoch: 1,
		seq: String(seq),
		ts: 1,
		level: 'info',
		category: [],
		msg: String(seq),
	}
}

describe('bounded log rows', () => {
	it('retains newest rows across append batches, late gaps and duplicates without mutating input snapshots', () => {
		const store = createLogStreamStore(50_000)
		const incoming = Array.from({ length: 50_000 }, (_, i) => line(i + 1))
		const notify = vi.fn()
		store.subscribe(notify)
		store.append(incoming)
		const snapshot = store.toArray()
		store.append([line(50_001), line(50_003)])
		expect(store.length).toBe(50_000)
		expect(store.get(0)?.seq).toBe('3')
		expect(store.get(store.length - 1)?.seq).toBe('50003')
		store.append([line(50_002), line(50_001)])
		expect(store.get(0)?.seq).toBe('4')
		expect(
			store
				.toArray()
				.slice(-3)
				.map((row) => row.seq),
		).toEqual(['50001', '50002', '50003'])
		store.append([line(50_001), line(1)])
		expect(notify).toHaveBeenCalledTimes(3)
		expect(incoming.length).toBe(50_000)
		expect(snapshot.length).toBe(50_000)
		expect(snapshot[0]?.seq).toBe('1')
	})
})
