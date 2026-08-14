type Entry = { key: string; expiresAt: number }

/** Indexed min-heap: exactly one node per live state, updated in O(log n). */
export class ExpiryHeap {
	private readonly entries: Entry[] = []
	private readonly indices = new Map<string, number>()

	get size(): number {
		return this.entries.length
	}
	peek(): Readonly<Entry> | undefined {
		return this.entries[0]
	}

	set(key: string, expiresAt: number): void {
		const index = this.indices.get(key)
		if (index === undefined) {
			const next = this.entries.length
			this.entries.push({ key, expiresAt })
			this.indices.set(key, next)
			this.up(next)
			return
		}
		const previous = this.entries[index]!.expiresAt
		this.entries[index]!.expiresAt = expiresAt
		if (expiresAt < previous) this.up(index)
		else if (expiresAt > previous) this.down(index)
	}

	delete(key: string): boolean {
		const index = this.indices.get(key)
		if (index === undefined) return false
		const last = this.entries.pop()!
		this.indices.delete(key)
		if (index < this.entries.length) {
			this.entries[index] = last
			this.indices.set(last.key, index)
			this.up(index)
			this.down(this.indices.get(last.key)!)
		}
		return true
	}

	clear(): void {
		this.entries.length = 0
		this.indices.clear()
	}

	private up(start: number): void {
		let index = start
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2)
			if (!less(this.entries[index]!, this.entries[parent]!)) break
			this.swap(index, parent)
			index = parent
		}
	}

	private down(start: number): void {
		let index = start
		for (;;) {
			const left = index * 2 + 1
			if (left >= this.entries.length) return
			const right = left + 1
			let child = left
			if (right < this.entries.length && less(this.entries[right]!, this.entries[left]!))
				child = right
			if (!less(this.entries[child]!, this.entries[index]!)) return
			this.swap(index, child)
			index = child
		}
	}

	private swap(a: number, b: number): void {
		const first = this.entries[a]!
		const second = this.entries[b]!
		this.entries[a] = second
		this.entries[b] = first
		this.indices.set(first.key, b)
		this.indices.set(second.key, a)
	}
}

function less(a: Entry, b: Entry): boolean {
	return a.expiresAt < b.expiresAt || (a.expiresAt === b.expiresAt && a.key < b.key)
}
