export class InstanceStore<K = unknown, V = unknown> {
	private readonly values = new Map<K, V>()
	private readonly keyRevisions = new Map<K, number>()
	private revision = 0

	public getRevision(): number {
		return this.revision
	}

	public getKeyRevision(key: K): number {
		return this.keyRevisions.get(key) ?? 0
	}

	public has(key: K): boolean {
		return this.values.has(key)
	}

	public peek(key: K): V | undefined {
		return this.values.get(key)
	}

	public set(key: K, value: V): this {
		this.values.set(key, value)
		this.revision += 1
		this.keyRevisions.set(key, this.revision)
		return this
	}

	public delete(key: K): boolean {
		const deleted = this.values.delete(key)
		if (deleted) {
			this.revision += 1
			this.keyRevisions.delete(key)
		}
		return deleted
	}

	public deleteMany(keys: Iterable<K>): void {
		let changed = false
		for (const key of keys) {
			if (!this.values.delete(key)) continue
			this.keyRevisions.delete(key)
			changed = true
		}
		if (changed) this.revision += 1
	}

	public clear(): void {
		if (this.values.size === 0) return
		this.values.clear()
		this.keyRevisions.clear()
		this.revision += 1
	}

	public entries(): IterableIterator<[K, V]> {
		return this.values.entries()
	}

	public keys(): IterableIterator<K> {
		return this.values.keys()
	}
}
