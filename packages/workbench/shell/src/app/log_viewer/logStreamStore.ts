import type { RuntimeLogLine } from '../../runtime'

export interface LogStreamStore {
	readonly length: number
	get(index: number): RuntimeLogLine | undefined
	getVersion(): number
	subscribe(listener: () => void): () => void
	toArray(): RuntimeLogLine[]
}

/** Ordered, bounded rows; late gap results merge without displacing newer rows. */
export function createLogStreamStore(capacity: number) {
	let rows: RuntimeLogLine[] = []
	let version = 0
	const listeners = new Set<() => void>()
	const changed = () => {
		version++
		for (const listener of listeners) listener()
	}
	return {
		get length() {
			return rows.length
		},
		get: (index: number) => rows[index],
		getVersion: () => version,
		toArray: () => rows.slice(),
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		clear() {
			if (rows.length > 0) {
				rows = []
				changed()
			}
		},
		append(incoming: readonly RuntimeLogLine[]) {
			if (incoming.length === 0) return
			let previous = rows.length > 0 ? BigInt(rows[rows.length - 1]!.seq) : -1n
			const appendOnly = incoming.every((line) => {
				const current = BigInt(line.seq)
				if (current <= previous) return false
				previous = current
				return true
			})
			if (appendOnly) {
				// Append checks/insertion cost O(batch); overflow shifts O(capacity) rows.
				// No sorting, merge walk, or second full retained buffer on this path.
				if (incoming.length >= capacity) rows = incoming.slice(-capacity)
				else {
					for (const line of incoming) rows.push(line)
					if (rows.length > capacity) rows.splice(0, rows.length - capacity)
				}
				changed()
				return
			}
			const additions = [...new Map(incoming.map((line) => [line.seq, line])).values()].sort(
				(a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0),
			)
			const merged: RuntimeLogLine[] = []
			let left = 0,
				right = 0
			while (left < rows.length || right < additions.length) {
				const existing = rows[left],
					next = additions[right]
				if (!next || (existing && BigInt(existing.seq) <= BigInt(next.seq))) {
					merged.push(existing!)
					left++
					if (next && existing!.seq === next.seq) right++
				} else {
					merged.push(next)
					right++
				}
			}
			const bounded = merged.slice(-capacity)
			if (bounded.length === rows.length && bounded.every((line, i) => line === rows[i])) return
			rows = bounded
			changed()
		},
	}
}
