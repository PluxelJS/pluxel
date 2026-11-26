export class InstanceStore<K = unknown, V = unknown> {
	private readonly values = new Map<K, V>()

	public has(key: K): boolean {
		return this.values.has(key)
	}

	public peek(key: K): V | undefined {
		return this.values.get(key)
	}

	public set(key: K, value: V): this {
		this.values.set(key, value)
		return this
	}

	public delete(key: K): boolean {
		return this.values.delete(key)
	}

	public deleteMany(keys: Iterable<K>): void {
		for (const key of keys) this.values.delete(key)
	}

	public clear(): void {
		this.values.clear()
	}

	public entries(): IterableIterator<[K, V]> {
		return this.values.entries()
	}

	public keys(): IterableIterator<K> {
		return this.values.keys()
	}
}
